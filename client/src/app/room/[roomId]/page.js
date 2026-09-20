import RoomClient from './RoomClient';

export function generateStaticParams() {
  return [{ roomId: 'demo' }];
}

export default function RoomPage() {
  return <RoomClient />;
}
