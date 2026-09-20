import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DYNAMODB_TABLE_NAME,
  AWS_REGION,
  DYNAMODB_ENDPOINT,
} from './config.js';

/**
 * AWS DynamoDB Room Manager for FaceTimeOS.
 *
 * Handles meeting room lifecycle (creation, state lookup, participant connection presence,
 * and room closure) backed by Amazon DynamoDB.
 *
 * Includes graceful fallback: if AWS credentials, IAM roles, or DynamoDB tables
 * are unavailable locally, it automatically falls back to an in-memory state store
 * so that local development and testing work seamlessly without errors.
 */

export class DynamoDBRoomManager {
  /**
   * @param {object} [options]
   * @param {string} [options.tableName] DynamoDB table name (defaults to DYNAMODB_TABLE_NAME)
   * @param {string} [options.region] AWS Region (defaults to AWS_REGION)
   * @param {string} [options.endpoint] Custom endpoint (e.g., LocalStack or DynamoDB Local)
   * @param {DynamoDBDocumentClient} [options.docClient] Custom injected DynamoDBDocumentClient
   * @param {boolean} [options.forceFallback] Force in-memory fallback (useful for tests)
   */
  constructor(options = {}) {
    this.tableName = options.tableName || DYNAMODB_TABLE_NAME || 'facetimeos-rooms';
    this.region = options.region || AWS_REGION || 'us-east-1';
    this.endpoint = options.endpoint || DYNAMODB_ENDPOINT || null;
    this.forceFallback = Boolean(options.forceFallback);

    /** In-memory fallback room store: roomId -> roomRecord */
    this.inMemoryStore = new Map();
    this.fallbackActive = this.forceFallback;
    this._warnedFallback = false;

    if (options.docClient) {
      this.docClient = options.docClient;
    } else if (!this.forceFallback) {
      try {
        const clientConfig = { region: this.region };
        if (this.endpoint) {
          clientConfig.endpoint = this.endpoint;
        }
        const rawClient = new DynamoDBClient(clientConfig);
        this.docClient = DynamoDBDocumentClient.from(rawClient, {
          marshallOptions: {
            removeUndefinedValues: true,
            convertClassInstanceToMap: true,
          },
        });
      } catch (err) {
        this._activateFallback(`Failed to initialize DynamoDB client: ${err.message}`);
      }
    }
  }

  _activateFallback(reason) {
    this.fallbackActive = true;
    if (!this._warnedFallback) {
      console.warn(`[aws:dynamodb] Falling back to in-memory room store. Reason: ${reason}`);
      this._warnedFallback = true;
    }
  }

  /** Check whether DynamoDB is active and not in fallback mode. */
  isDynamoAvailable() {
    return !this.fallbackActive && Boolean(this.docClient);
  }

  /**
   * Create a new room in DynamoDB (or in-memory fallback).
   *
   * @param {string} roomId
   * @param {object} [hostInfo] Information about the creating host
   * @param {object} [metadata] Additional room metadata (title, locked, etc.)
   * @returns {Promise<object>} The stored room record
   */
  async createRoom(roomId, hostInfo = {}, metadata = {}) {
    if (!roomId) throw new Error('roomId is required to create a room');

    const now = new Date().toISOString();
    // Default 72-hour TTL epoch for DynamoDB automatic expiration
    const ttlEpochSeconds = Math.floor(Date.now() / 1000) + (72 * 60 * 60);

    const roomRecord = {
      roomId,
      status: 'active',
      hostInfo: hostInfo || {},
      metadata: metadata || {},
      participants: {},
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      ttl: ttlEpochSeconds,
    };

    // Always mirror to in-memory store so reads remain instant and consistent
    this.inMemoryStore.set(roomId, JSON.parse(JSON.stringify(roomRecord)));

    if (!this.fallbackActive && this.docClient) {
      try {
        await this.docClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: roomRecord,
          })
        );
      } catch (err) {
        this._activateFallback(`createRoom failed (${err.name}: ${err.message})`);
      }
    }

    return roomRecord;
  }

  /**
   * Retrieve a room by roomId from DynamoDB (or in-memory fallback).
   *
   * @param {string} roomId
   * @returns {Promise<object|null>} The room record, or null if not found
   */
  async getRoom(roomId) {
    if (!roomId) return null;

    if (!this.fallbackActive && this.docClient) {
      try {
        const result = await this.docClient.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { roomId },
          })
        );
        if (result?.Item) {
          // Sync with local memory cache
          this.inMemoryStore.set(roomId, result.Item);
          return result.Item;
        }
      } catch (err) {
        this._activateFallback(`getRoom failed (${err.name}: ${err.message})`);
      }
    }

    return this.inMemoryStore.get(roomId) || null;
  }

  /**
   * Update participant connection presence and state in the room.
   *
   * @param {string} roomId
   * @param {string} participantId
   * @param {boolean} isConnected
   * @param {object} [participantData] Optional additional metadata (displayName, role, etc.)
   * @returns {Promise<object|null>} The updated participant state
   */
  async updateParticipantState(roomId, participantId, isConnected, participantData = {}) {
    if (!roomId || !participantId) {
      throw new Error('roomId and participantId are required to update participant state');
    }

    const now = new Date().toISOString();
    const presence = {
      participantId,
      isConnected: Boolean(isConnected),
      lastSeen: now,
      ...participantData,
    };

    // Update in-memory state
    let memoryRoom = this.inMemoryStore.get(roomId);
    if (!memoryRoom) {
      memoryRoom = {
        roomId,
        status: 'active',
        hostInfo: {},
        metadata: {},
        participants: {},
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      this.inMemoryStore.set(roomId, memoryRoom);
    }
    if (!memoryRoom.participants) {
      memoryRoom.participants = {};
    }
    memoryRoom.participants[participantId] = {
      ...(memoryRoom.participants[participantId] || {}),
      ...presence,
    };
    memoryRoom.updatedAt = now;

    if (!this.fallbackActive && this.docClient) {
      try {
        // Update participant in DynamoDB using nested map path
        await this.docClient.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { roomId },
            UpdateExpression: 'SET #participants.#pid = :pdata, #updatedAt = :now',
            ExpressionAttributeNames: {
              '#participants': 'participants',
              '#pid': participantId,
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':pdata': presence,
              ':now': now,
            },
          })
        );
      } catch (err) {
        // If room document doesn't exist yet or participants is undefined, retry with set
        if (err.name === 'ValidationException') {
          try {
            await this.docClient.send(
              new UpdateCommand({
                TableName: this.tableName,
                Key: { roomId },
                UpdateExpression: 'SET #participants = if_not_exists(#participants, :emptyMap), #updatedAt = :now',
                ExpressionAttributeNames: {
                  '#participants': 'participants',
                  '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: {
                  ':emptyMap': { [participantId]: presence },
                  ':now': now,
                },
              })
            );
          } catch (retryErr) {
            this._activateFallback(`updateParticipantState retry failed (${retryErr.message})`);
          }
        } else {
          this._activateFallback(`updateParticipantState failed (${err.name}: ${err.message})`);
        }
      }
    }

    return presence;
  }

  /**
   * Close a room and record the closed timestamp.
   *
   * @param {string} roomId
   * @returns {Promise<{ok: boolean, roomId: string, status: string}>}
   */
  async closeRoom(roomId) {
    if (!roomId) return { ok: false, error: 'missing-roomId' };

    const now = new Date().toISOString();

    // Update in-memory state
    const memoryRoom = this.inMemoryStore.get(roomId);
    if (memoryRoom) {
      memoryRoom.status = 'closed';
      memoryRoom.closedAt = now;
      memoryRoom.updatedAt = now;
    }

    if (!this.fallbackActive && this.docClient) {
      try {
        await this.docClient.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { roomId },
            UpdateExpression: 'SET #status = :status, #closedAt = :now, #updatedAt = :now',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#closedAt': 'closedAt',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':status': 'closed',
              ':now': now,
            },
          })
        );
      } catch (err) {
        this._activateFallback(`closeRoom failed (${err.name}: ${err.message})`);
      }
    }

    return { ok: true, roomId, status: 'closed', closedAt: now };
  }

  /**
   * Operational status and health telemetry.
   */
  stats() {
    return {
      provider: this.isDynamoAvailable() ? 'amazon-dynamodb' : 'in-memory-fallback',
      tableName: this.tableName,
      region: this.region,
      activeRoomsInMemory: this.inMemoryStore.size,
      fallbackActive: this.fallbackActive,
    };
  }

  /**
   * Reset in-memory state (test seam).
   */
  _reset() {
    this.inMemoryStore.clear();
    this.fallbackActive = this.forceFallback;
    this._warnedFallback = false;
  }
}

/** Singleton instance used by the FaceTimeOS server */
export const dynamoDbRoomManager = new DynamoDBRoomManager();

// Export the required lifecycle functions bound to the singleton instance
export const createRoom = (roomId, hostInfo, metadata) =>
  dynamoDbRoomManager.createRoom(roomId, hostInfo, metadata);

export const getRoom = (roomId) =>
  dynamoDbRoomManager.getRoom(roomId);

export const updateParticipantState = (roomId, participantId, isConnected, participantData) =>
  dynamoDbRoomManager.updateParticipantState(roomId, participantId, isConnected, participantData);

export const closeRoom = (roomId) =>
  dynamoDbRoomManager.closeRoom(roomId);

export default dynamoDbRoomManager;
