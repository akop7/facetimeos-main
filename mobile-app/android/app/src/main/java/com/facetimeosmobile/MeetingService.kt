package com.facetimeosmobile

import android.app.*
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

class MeetingService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) { stopSelf(); return START_NOT_STICKY }
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("meeting", "Active meeting", NotificationManager.IMPORTANCE_LOW))
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(this, "meeting")
      .setSmallIcon(R.drawable.ic_notification).setContentTitle("FaceTimeOS meeting")
      .setContentText("Tap to return to your call or leave the meeting")
      .setContentIntent(open).setOngoing(true).setCategory(NotificationCompat.CATEGORY_CALL)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
    val types = (if (intent.getBooleanExtra("mic", false)) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0) or
      (if (intent.getBooleanExtra("camera", false)) ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA else 0)
    if (types == 0) { stopSelf(); return START_NOT_STICKY }
    ServiceCompat.startForeground(this, 7301, notification, if (Build.VERSION.SDK_INT >= 30) types else 0)
    return START_NOT_STICKY
  }
  override fun onTaskRemoved(rootIntent: Intent?) { stopSelf(); super.onTaskRemoved(rootIntent) }
}
