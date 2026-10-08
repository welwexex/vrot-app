package `fun`.vrot.android

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Videocam
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.FloatingActionButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

class IncomingCallActivity : ComponentActivity() {
    companion object {
        private var activeActivity: IncomingCallActivity? = null
        fun dismissActive() {
            activeActivity?.let {
                if (!it.isFinishing && !it.isDestroyed) {
                    it.finish()
                }
            }
            activeActivity = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activeActivity = this
        wakeAndUnlock()

        val friendId = intent.getStringExtra("friendId").orEmpty()
        val callerName = intent.getStringExtra("callerName").orEmpty().ifBlank { "Собеседник" }
        val video = intent.getBooleanExtra("video", false)
        val callId = intent.getStringExtra("callId").orEmpty()

        val timeoutHandler = android.os.Handler(android.os.Looper.getMainLooper())
        val timeoutRunnable = Runnable {
            if (!isFinishing && !isDestroyed) {
                SystemCalls.cancelCallNotification(this, callId)
                finish()
            }
        }
        timeoutHandler.postDelayed(timeoutRunnable, 15000)

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                IncomingCallScreen(
                    callerName = callerName,
                    video = video,
                    onAccept = {
                        timeoutHandler.removeCallbacks(timeoutRunnable)
                        SystemCalls.cancelCallNotification(this, callId)
                        val conn = VrotConnectionService.currentConnection
                        if (conn != null) {
                            conn.onAnswer()
                        } else {
                            val app = application as? VrotApplication
                            app?.calls?.accept(friendId, callerName, video)
                            CallService.start(this, callerName, video)
                            val mainIntent = Intent(this, MainActivity::class.java).apply {
                                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                            }
                            startActivity(mainIntent)
                        }
                        finish()
                    },
                    onDecline = {
                        timeoutHandler.removeCallbacks(timeoutRunnable)
                        SystemCalls.cancelCallNotification(this, callId)
                        val conn = VrotConnectionService.currentConnection
                        if (conn != null) {
                            conn.onReject()
                        } else {
                            val app = application as? VrotApplication
                            if (friendId.isNotEmpty()) {
                                app?.realtime?.active?.emit("call:cancel", org.json.JSONObject().put("friendId", friendId).put("callId", callId))
                            }
                            app?.calls?.end()
                        }
                        finish()
                    }
                )
            }
        }
    }

    private fun wakeAndUnlock() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            keyguardManager?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (activeActivity == this) {
            activeActivity = null
        }
    }
}

@Composable
fun IncomingCallScreen(
    callerName: String,
    video: Boolean,
    onAccept: () -> Unit,
    onDecline: () -> Unit
) {
    val pulse = remember { Animatable(1f) }
    LaunchedEffect(Unit) {
        while (true) {
            pulse.animateTo(1.15f, animationSpec = tween(700))
            pulse.animateTo(1f, animationSpec = tween(700))
        }
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color(0xFF0F121C)
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        colors = listOf(
                            Color(0xFF1E2238),
                            Color(0xFF0F121C),
                            Color(0xFF0A0C14)
                        )
                    )
                )
                .padding(32.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
                    .padding(top = 80.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Avatar circle with pulsing glow
                Box(
                    modifier = Modifier
                        .size(120.dp)
                        .scale(pulse.value)
                        .background(Color(0xFF5865F2).copy(alpha = 0.25f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        modifier = Modifier
                            .size(96.dp)
                            .background(Color(0xFF5865F2), CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = callerName.take(1).uppercase(),
                            color = Color.White,
                            fontSize = 38.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }

                Spacer(modifier = Modifier.height(28.dp))

                Text(
                    text = callerName,
                    color = Color.White,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Bold
                )

                Spacer(modifier = Modifier.height(8.dp))

                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (video) {
                        Icon(
                            imageVector = Icons.Default.Videocam,
                            contentDescription = null,
                            tint = Color(0xFF9AA4B2),
                            modifier = Modifier.size(20.dp)
                        )
                        Spacer(modifier = Modifier.size(6.dp))
                    }
                    Text(
                        text = if (video) "Входящий видеовызов Врот…" else "Входящий аудиовызов Врот…",
                        color = Color(0xFF9AA4B2),
                        fontSize = 16.sp
                    )
                }
            }

            // Action Buttons (Decline / Accept)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 50.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    FloatingActionButton(
                        onClick = onDecline,
                        containerColor = Color(0xFFED4245),
                        contentColor = Color.White,
                        shape = CircleShape,
                        elevation = FloatingActionButtonDefaults.elevation(6.dp),
                        modifier = Modifier.size(72.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.CallEnd,
                            contentDescription = "Отклонить",
                            modifier = Modifier.size(34.dp)
                        )
                    }
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = "Отклонить",
                        color = Color.White.copy(alpha = 0.8f),
                        fontSize = 14.sp
                    )
                }

                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    FloatingActionButton(
                        onClick = onAccept,
                        containerColor = Color(0xFF57F287),
                        contentColor = Color.White,
                        shape = CircleShape,
                        elevation = FloatingActionButtonDefaults.elevation(6.dp),
                        modifier = Modifier
                            .size(72.dp)
                            .scale(pulse.value)
                    ) {
                        Icon(
                            imageVector = if (video) Icons.Default.Videocam else Icons.Default.Call,
                            contentDescription = "Ответить",
                            modifier = Modifier.size(34.dp)
                        )
                    }
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        text = "Ответить",
                        color = Color.White.copy(alpha = 0.8f),
                        fontSize = 14.sp
                    )
                }
            }
        }
    }
}
