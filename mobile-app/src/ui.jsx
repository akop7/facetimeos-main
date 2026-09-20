import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
export const C = {
  bg: '#f5f7fb',
  white: '#ffffff',
  ink: '#17233b',
  muted: '#738097',
  line: '#e4e9f1',
  blue: '#3868ef',
  navy: '#121d32',
  dark: '#0b1322',
  green: '#1cba8b',
  red: '#e44759',
};
export function Button({
  children,
  onPress,
  icon: Icon,
  secondary,
  danger,
  disabled,
  loading,
  style,
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        s.button,
        secondary && s.secondary,
        danger && { backgroundColor: C.red },
        (disabled || loading) && { opacity: 0.45 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={secondary ? C.blue : C.white} />
      ) : Icon ? (
        <Icon size={19} color={secondary ? C.ink : C.white} />
      ) : null}
      <Text style={[s.buttonText, secondary && { color: C.ink }]}>
        {children}
      </Text>
    </Pressable>
  );
}
export function Field({ label, style, ...props }) {
  return (
    <View style={style}>
      {label && <Text style={s.label}>{label}</Text>}
      <TextInput
        placeholderTextColor={C.muted}
        style={s.input}
        autoCapitalize="none"
        {...props}
      />
    </View>
  );
}
export function Empty({ icon: Icon, title, text }) {
  return (
    <View style={s.empty}>
      {Icon && <Icon size={33} color={C.muted} />}
      <Text style={s.h3}>{title}</Text>
      <Text style={s.sub}>{text}</Text>
    </View>
  );
}
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: { padding: 22, gap: 20, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  between: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  brand: { fontSize: 22, fontWeight: '800', color: C.ink, letterSpacing: -0.8 },
  badge: { padding: 10, borderRadius: 14, backgroundColor: '#eaf0ff' },
  eyebrow: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.8,
    color: C.muted,
  },
  h1: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: '800',
    color: C.ink,
    letterSpacing: -1.1,
  },
  h2: { fontSize: 21, fontWeight: '700', color: C.ink, letterSpacing: -0.4 },
  h3: { fontSize: 16, fontWeight: '700', color: C.ink },
  sub: { fontSize: 14, lineHeight: 22, color: C.muted },
  card: {
    backgroundColor: C.white,
    borderRadius: 23,
    padding: 22,
    gap: 15,
    borderWidth: 1,
    borderColor: C.line,
  },
  button: {
    minHeight: 52,
    borderRadius: 14,
    paddingHorizontal: 17,
    paddingVertical: 12,
    backgroundColor: C.blue,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
  },
  secondary: { backgroundColor: '#edf1f8' },
  buttonText: { color: C.white, fontSize: 14, fontWeight: '700' },
  label: { fontSize: 12, fontWeight: '600', color: C.ink, marginBottom: 8 },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: C.line,
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: C.white,
    color: C.ink,
    fontSize: 15,
  },
  error: { backgroundColor: '#fff0f0', borderRadius: 12, padding: 14 },
  errorText: { color: '#ad3343', fontSize: 13, lineHeight: 20 },
  link: { fontSize: 13, color: C.blue, fontWeight: '600' },
  empty: { padding: 30, alignItems: 'center', gap: 10 },
  chip: {
    borderRadius: 12,
    backgroundColor: '#edf1f8',
    padding: 12,
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
  },
  small: { fontSize: 12, color: C.muted },
  divider: { height: 1, backgroundColor: C.line },
});
