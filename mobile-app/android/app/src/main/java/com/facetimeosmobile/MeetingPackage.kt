package com.facetimeosmobile

import android.app.Activity
import android.content.Intent
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MeetingPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(MeetingModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class MeetingModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var exportPromise: Promise? = null
  private var exportData: ByteArray? = null
  override fun getName() = "FaceTimeMeeting"
  init {
    context.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != 7310) return
        try {
          if (resultCode != Activity.RESULT_OK || data?.data == null) exportPromise?.resolve(false)
          else {
            context.contentResolver.openOutputStream(data.data!!)?.use { it.write(exportData ?: byteArrayOf()) }
              ?: throw IllegalStateException("Cannot write to the selected destination")
            exportPromise?.resolve(true)
          }
        } catch (error: Exception) { exportPromise?.reject("export", "Could not save the export", error) }
        finally { exportPromise = null; exportData = null }
      }
    })
  }
  @ReactMethod fun startMeeting(mic: Boolean, camera: Boolean, promise: Promise) {
    try {
      if (!mic && !camera) { stopMeeting(); promise.resolve(true); return }
      ContextCompat.startForegroundService(context, Intent(context, MeetingService::class.java).putExtra("mic", mic).putExtra("camera", camera))
      promise.resolve(true)
    } catch (error: Exception) { promise.reject("meeting-service", "Return to the app and allow microphone/camera access", error) }
  }
  @ReactMethod fun stopMeeting() { context.stopService(Intent(context, MeetingService::class.java)) }
  @ReactMethod fun exportZip(filename: String, base64: String, promise: Promise) {
    if (exportPromise != null) { promise.reject("busy", "An export is already open"); return }
    val activity = context.currentActivity
    if (activity == null || base64.length > 24000000) { promise.reject("export", "Export unavailable or too large"); return }
    try {
      exportData = Base64.decode(base64, Base64.DEFAULT); exportPromise = promise
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
        .setType("application/zip").putExtra(Intent.EXTRA_TITLE, filename.replace(Regex("[^a-zA-Z0-9._-]"), "_").take(100))
      activity.startActivityForResult(intent, 7310)
    } catch (error: Exception) { exportPromise = null; exportData = null; promise.reject("export", "Could not open file picker", error) }
  }
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey("facetimeos.sessions", null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder("facetimeos.sessions", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  @ReactMethod fun saveSession(roomId: String, value: String, promise: Promise) {
    if (!Regex("[0-9a-fA-F-]{36}").matches(roomId) || value.length > 20000) { promise.reject("session", "Invalid session"); return }
    try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key())
      val encoded = Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
      context.getSharedPreferences("sessions", 0).edit().putString(roomId, encoded).apply(); promise.resolve(true)
    } catch (error: Exception) { promise.reject("session", "Could not securely save the session", error) }
  }
  @ReactMethod fun loadSession(roomId: String, promise: Promise) {
    try {
      val saved = context.getSharedPreferences("sessions", 0).getString(roomId, null)
      if (saved == null) { promise.resolve(null); return }
      val bytes = Base64.decode(saved, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      promise.resolve(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    } catch (_: Exception) { promise.resolve(null) }
  }
  @ReactMethod fun clearSessions(promise: Promise) {
    context.getSharedPreferences("sessions", 0).edit().clear().apply(); promise.resolve(true)
  }
}
