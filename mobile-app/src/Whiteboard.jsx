import React, { useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Svg, {
  Defs,
  Ellipse,
  G,
  Line,
  Mask,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';
import { Redo2, Trash2, Undo2 } from 'lucide-react-native';
import { C, s } from './ui';

const palette = [
  '#3868ef',
  '#ef4444',
  '#22c55e',
  '#eab308',
  '#ec4899',
  '#111827',
];
function Stroke({ stroke, width, height, erase = false }) {
  const p = stroke.points || [];
  if (!p.length) return null;
  const first = p[0],
    last = p[p.length - 1];
  const props = {
    stroke: erase ? 'black' : stroke.color,
    strokeWidth: (stroke.width || 2) * (stroke.tool === 'eraser' ? 4 : 1),
    fill: 'none',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
  if (stroke.tool === 'text')
    return (
      <SvgText
        x={first.x * width}
        y={first.y * height}
        alignmentBaseline="hanging"
        fill={stroke.color}
        fontSize={Math.max(13, (stroke.width || 2) * 7)}
      >
        {stroke.text}
      </SvgText>
    );
  if (stroke.tool === 'rectangle')
    return (
      <Rect
        {...props}
        x={Math.min(first.x, last.x) * width}
        y={Math.min(first.y, last.y) * height}
        width={Math.abs(last.x - first.x) * width}
        height={Math.abs(last.y - first.y) * height}
      />
    );
  if (stroke.tool === 'circle')
    return (
      <Ellipse
        {...props}
        cx={((first.x + last.x) * width) / 2}
        cy={((first.y + last.y) * height) / 2}
        rx={(Math.abs(last.x - first.x) * width) / 2}
        ry={(Math.abs(last.y - first.y) * height) / 2}
      />
    );
  if (stroke.tool === 'line')
    return (
      <Line
        {...props}
        x1={first.x * width}
        y1={first.y * height}
        x2={last.x * width}
        y2={last.y * height}
      />
    );
  return (
    <Path
      {...props}
      d={
        p
          .map(
            (point, index) =>
              `${index ? 'L' : 'M'}${point.x * width},${point.y * height}`,
          )
          .join(' ') + (p.length === 1 ? ` l0.1,0` : '')
      }
    />
  );
}
export default function Whiteboard({ engine, revision }) {
  const board = engine.doc.getArray('whiteboard');
  const strokes = board.toArray();
  const editable = engine.canEdit('whiteboard');
  const [tool, setTool] = useState('pen'),
    [color, setColor] = useState(palette[0]),
    [width, setWidth] = useState(2),
    [size, setSize] = useState({ w: 1, h: 1 });
  const [draft, setDraft] = useState(null),
    [text, setText] = useState(''),
    [redoCount, setRedoCount] = useState(0);
  const drawing = useRef(null),
    redo = useRef([]);
  const point = e => ({
    x: Math.max(0, Math.min(1, e.nativeEvent.locationX / size.w)),
    y: Math.max(0, Math.min(1, e.nativeEvent.locationY / size.h)),
  });
  function start(e) {
    if (!editable) return;
    if (tool === 'text' && !text.trim()) {
      Alert.alert(
        'Add text',
        'Type your text above, then tap where it should appear.',
      );
      return;
    }
    const value = {
      id: `${Date.now()}-${Math.random()}`,
      by: engine.session.peerId,
      at: Date.now(),
      tool,
      color,
      width,
      points: [point(e)],
      ...(tool === 'text' ? { text: text.trim() } : {}),
    };
    drawing.current = value;
    setDraft(value);
  }
  function move(e) {
    const stroke = drawing.current;
    if (!stroke || stroke.tool === 'text') return;
    const next = point(e);
    stroke.points = ['line', 'rectangle', 'circle'].includes(stroke.tool)
      ? [stroke.points[0], next]
      : [...stroke.points, next];
    if (stroke.points.length > 2000)
      stroke.points = stroke.points.filter((_, i) => i % 2 === 0);
    setDraft({ ...stroke });
  }
  function finish() {
    if (drawing.current && engine.canEdit('whiteboard')) {
      board.push([drawing.current]);
      redo.current = [];
      setRedoCount(0);
    }
    drawing.current = null;
    setDraft(null);
  }
  function undoStroke() {
    if (!editable) return;
    const list = board.toArray();
    let index = list.length - 1;
    while (index >= 0 && list[index]?.by !== engine.session.peerId) index--;
    if (index >= 0) {
      redo.current.push(list[index]);
      board.delete(index, 1);
      setRedoCount(redo.current.length);
    }
  }
  function redoStroke() {
    if (editable && redo.current.length) {
      board.push([redo.current.pop()]);
      setRedoCount(redo.current.length);
    }
  }
  let rendered = [];
  const masks = [];
  // Mask only previously drawn content: new strokes remain visible over an old eraser.
  strokes.forEach((stroke, index) => {
    if (!stroke?.points?.length) return;
    if (stroke.tool === 'eraser') {
      const id = `erase-${index}`;
      masks.push(
        <Mask
          id={id}
          key={id}
          x="0"
          y="0"
          width={size.w}
          height={size.h}
          maskUnits="userSpaceOnUse"
        >
          <Rect width={size.w} height={size.h} fill="white" />
          <Stroke stroke={stroke} width={size.w} height={size.h} erase />
        </Mask>,
      );
      rendered = [
        <G key={id} mask={`url(#${id})`}>
          {rendered}
        </G>,
      ];
    } else
      rendered.push(
        <Stroke
          key={stroke.id || index}
          stroke={stroke}
          width={size.w}
          height={size.h}
        />,
      );
  });
  return (
    <View style={{ flex: 1, gap: 10 }}>
      <ScrollView
        horizontal
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ gap: 7 }}
        showsHorizontalScrollIndicator={false}
      >
        {['pen', 'line', 'rectangle', 'circle', 'text', 'eraser'].map(value => (
          <Pressable
            key={value}
            disabled={!editable}
            onPress={() => setTool(value)}
            style={[s.chip, tool === value && { backgroundColor: '#dce7ff' }]}
          >
            <Text
              style={{
                color: C.ink,
                fontSize: 12,
                textTransform: 'capitalize',
              }}
            >
              {value === 'circle' ? 'Ellipse' : value}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={s.between}>
        <View style={[s.row, { gap: 8 }]}>
          {palette.map(value => (
            <Pressable
              key={value}
              accessibilityLabel={`Ink ${value}`}
              onPress={() => setColor(value)}
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: value,
                borderWidth: color === value ? 3 : 0,
                borderColor: '#a7bce8',
              }}
            />
          ))}
        </View>
        <Pressable
          onPress={() => setWidth(width === 2 ? 5 : width === 5 ? 12 : 2)}
          style={s.chip}
        >
          <Text style={s.small}>{width}px</Text>
        </Pressable>
      </View>
      {tool === 'text' && (
        <TextInput
          style={s.input}
          placeholder="Type text, then tap the board"
          placeholderTextColor={C.muted}
          value={text}
          onChangeText={setText}
          maxLength={300}
        />
      )}
      {!editable && (
        <Text style={s.small}>
          View only. Ask the host for whiteboard access.
        </Text>
      )}
      <View
        style={{
          flex: 1,
          minHeight: 220,
          backgroundColor: 'white',
          borderRadius: 14,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: C.line,
        }}
        onLayout={e =>
          setSize({
            w: e.nativeEvent.layout.width,
            h: e.nativeEvent.layout.height,
          })
        }
        onStartShouldSetResponder={() => editable}
        onMoveShouldSetResponder={() => editable}
        onResponderGrant={start}
        onResponderMove={move}
        onResponderRelease={finish}
        onResponderTerminate={() => {
          drawing.current = null;
          setDraft(null);
        }}
      >
        <Svg width={size.w} height={size.h} pointerEvents="none">
          <Defs>{masks}</Defs>
          {rendered}
          {draft && (
            <Stroke
              stroke={
                draft.tool === 'eraser' ? { ...draft, color: '#9ca3af' } : draft
              }
              width={size.w}
              height={size.h}
            />
          )}
        </Svg>
      </View>
      <View style={s.row}>
        <Pressable
          accessibilityLabel="Undo my stroke"
          disabled={!editable}
          onPress={undoStroke}
          style={s.chip}
        >
          <Undo2 color={C.ink} size={17} />
          <Text style={s.small}>Undo</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Redo my stroke"
          disabled={!editable || !redoCount}
          onPress={redoStroke}
          style={[s.chip, !redoCount && { opacity: 0.4 }]}
        >
          <Redo2 color={C.ink} size={17} />
          <Text style={s.small}>Redo</Text>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          disabled={!editable}
          onPress={() =>
            Alert.alert(
              'Clear the shared whiteboard?',
              'This removes everyone’s strokes from this board.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Clear board',
                  style: 'destructive',
                  onPress: () => {
                    if (engine.canEdit('whiteboard'))
                      board.delete(0, board.length);
                    redo.current = [];
                    setRedoCount(0);
                  },
                },
              ],
            )
          }
          style={s.chip}
        >
          <Trash2 size={18} color={C.red} />
        </Pressable>
      </View>
    </View>
  );
}
