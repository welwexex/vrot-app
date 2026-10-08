package `fun`.vrot.android

import android.Manifest
import android.app.DatePickerDialog
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import java.util.Calendar
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer

val VrotDarkBg = Color(0xFF070911)
val VrotSurface = Color(0xFF0F1320)
val VrotCard = Color(0xFF181D2D)
val VrotAccent = Color(0xFF927CFF)
val VrotGreen = Color(0xFF5CE2C2)
val VrotRed = Color(0xFFFF657D)
val VrotTextPrimary = Color(0xFFF7F8FF)
val VrotTextSecondary = Color(0xFF9BA5BC)

class MainActivity : ComponentActivity() {
    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as VrotApplication

        requestAppPermissions()

        val dmTarget = intent.getStringExtra("dm")
        val channelTarget = intent.getStringExtra("channel")

        setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    background = VrotDarkBg,
                    surface = VrotSurface,
                    primary = VrotAccent,
                    onPrimary = Color.White
                )
            ) {
                Surface(modifier = Modifier.fillMaxSize(), color = VrotDarkBg) {
                    VrotAppScreen(app = app, initialDm = dmTarget, initialChannel = channelTarget)
                }
            }
        }
    }

    private fun requestAppPermissions() {
        val permissions = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            permissions.add(Manifest.permission.MANAGE_OWN_CALLS)
        }

        val needed = permissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (needed.isNotEmpty()) {
            requestPermissionLauncher.launch(needed.toTypedArray())
        }
    }
}

@Composable
fun VrotAppScreen(app: VrotApplication, initialDm: String?, initialChannel: String?) {
    var loggedIn by remember { mutableStateOf(app.session.cookie() != null) }
    var currentUser by remember { mutableStateOf<JSONObject?>(null) }
    val scope = rememberCoroutineScope()
    val callState by app.calls.state.collectAsState()

    LaunchedEffect(loggedIn) {
        if (loggedIn) {
            try {
                val res = app.api.obj("/api/auth/me")
                currentUser = res.optJSONObject("user")
                app.realtime.connect()
                app.registerPush()
            } catch (e: Exception) {
                loggedIn = false
                app.session.clear()
            }
        }
    }

    if (callState.active) {
        ActiveCallOverlay(app = app)
    } else if (!loggedIn) {
        AuthScreen(
            onLoggedIn = {
                loggedIn = true
            },
            api = app.api
        )
    } else {
        MainSocialScreen(
            app = app,
            currentUser = currentUser,
            initialDm = initialDm,
            initialChannel = initialChannel,
            onLogout = {
                scope.launch {
                    runCatching { app.api.request("/api/auth/logout", "POST") }
                    app.session.clear()
                    app.realtime.disconnect()
                    loggedIn = false
                    currentUser = null
                }
            }
        )
    }
}

@Composable
fun AuthScreen(onLoggedIn: () -> Unit, api: Api) {
    var mode by remember { mutableStateOf<String>("login") } // "login", "register", "reset-request", "reset-confirm"
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var username by remember { mutableStateOf("") }
    var birthDate by remember { mutableStateOf("") } // YYYY-MM-DD
    var legalAccepted by remember { mutableStateOf(false) }
    var resetCode by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }

    var error by remember { mutableStateOf("") }
    var notice by remember { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var configLoaded by remember { mutableStateOf(false) }
    var regMode by remember { mutableStateOf("open") }
    var minAge by remember { mutableStateOf(18) }
    var siteSlogan by remember { mutableStateOf("Своё место для своих.") }

    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            val cfg = api.obj("/api/config")
            regMode = cfg.optString("registrationMode", "open")
            minAge = cfg.optInt("minimumAge", 18)
            siteSlogan = cfg.optString("siteSlogan", "Своё место для своих.")
            configLoaded = true
        } catch (_: Exception) {}
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(VrotDarkBg)
            .padding(20.dp),
        contentAlignment = Alignment.Center
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .widthIn(max = 440.dp),
            colors = CardDefaults.cardColors(containerColor = VrotSurface),
            shape = RoundedCornerShape(20.dp)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Logo & Slogan
                Text(
                    text = "VROT",
                    color = VrotAccent,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.Black,
                    letterSpacing = 1.sp
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = siteSlogan,
                    color = VrotTextSecondary,
                    fontSize = 13.sp
                )

                Spacer(modifier = Modifier.height(20.dp))

                // Mode Tabs (Вход / Регистрация)
                if (mode == "login" || mode == "register") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(VrotCard)
                            .padding(4.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (mode == "login") VrotAccent else Color.Transparent)
                                .clickable {
                                    mode = "login"
                                    error = ""
                                    notice = ""
                                }
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "Вход",
                                color = if (mode == "login") Color.White else VrotTextSecondary,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp
                            )
                        }
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(8.dp))
                                .background(if (mode == "register") VrotAccent else Color.Transparent)
                                .clickable {
                                    mode = "register"
                                    error = ""
                                    notice = ""
                                }
                                .padding(vertical = 10.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                "Регистрация",
                                color = if (mode == "register") Color.White else VrotTextSecondary,
                                fontWeight = FontWeight.SemiBold,
                                fontSize = 14.sp
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(18.dp))

                Text(
                    text = when (mode) {
                        "login" -> "С возвращением"
                        "register" -> "Создать аккаунт"
                        "reset-request" -> "Восстановить пароль"
                        else -> "Введите код из письма"
                    },
                    color = Color.White,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold
                )

                Spacer(modifier = Modifier.height(14.dp))

                // Registration closed warning if applicable
                if (mode == "register" && regMode != "open") {
                    Card(
                        modifier = Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = Color(0xFF261D13)),
                        shape = RoundedCornerShape(10.dp)
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text("Регистрация временно закрыта", color = Color(0xFFFFB74D), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("Публичная регистрация откроется позже. Уже созданные пользователи могут войти.", color = VrotTextSecondary, fontSize = 12.sp)
                        }
                    }
                    Spacer(modifier = Modifier.height(12.dp))
                }

                // FORM FIELDS
                when (mode) {
                    "login" -> {
                        OutlinedTextField(
                            value = email,
                            onValueChange = { email = it },
                            label = { Text("Email") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text("Пароль") },
                            visualTransformation = PasswordVisualTransformation(),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            TextButton(onClick = {
                                mode = "reset-request"
                                error = ""
                                notice = ""
                            }) {
                                Text("Забыли пароль?", color = VrotAccent, fontSize = 13.sp)
                            }
                        }
                    }
                    "register" -> {
                        OutlinedTextField(
                            value = username,
                            onValueChange = { username = it },
                            label = { Text("Имя пользователя (от 3 симв.)") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = email,
                            onValueChange = { email = it },
                            label = { Text("Email") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = password,
                            onValueChange = { password = it },
                            label = { Text("Пароль (мин. 12 симв.)") },
                            visualTransformation = PasswordVisualTransformation(),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        val context = LocalContext.current
                        val calendar = remember { Calendar.getInstance() }
                        calendar.add(Calendar.YEAR, -18)
                        val maxYear = calendar.get(Calendar.YEAR)
                        val maxMonth = calendar.get(Calendar.MONTH)
                        val maxDay = calendar.get(Calendar.DAY_OF_MONTH)

                        val openDatePicker = {
                            val dpd = DatePickerDialog(
                                context,
                                { _, year, month, dayOfMonth ->
                                    val mStr = String.format("%02d", month + 1)
                                    val dStr = String.format("%02d", dayOfMonth)
                                    birthDate = "$year-$mStr-$dStr"
                                },
                                if (birthDate.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) birthDate.split("-")[0].toInt() else maxYear,
                                if (birthDate.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) birthDate.split("-")[1].toInt() - 1 else maxMonth,
                                if (birthDate.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) birthDate.split("-")[2].toInt() else maxDay
                            )
                            dpd.datePicker.maxDate = calendar.timeInMillis
                            dpd.show()
                        }

                        Box(modifier = Modifier.fillMaxWidth().clickable { openDatePicker() }) {
                            OutlinedTextField(
                                value = birthDate,
                                onValueChange = { birthDate = it },
                                label = { Text("Дата рождения (ГГГГ-ММ-ДД)") },
                                placeholder = { Text("Нажмите для выбора даты", color = VrotTextSecondary) },
                                readOnly = true,
                                trailingIcon = {
                                    IconButton(onClick = { openDatePicker() }) {
                                        Icon(Icons.Default.DateRange, contentDescription = "Выбрать дату", tint = VrotAccent)
                                    }
                                },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedTextColor = Color.White,
                                    unfocusedTextColor = Color.White,
                                    focusedBorderColor = VrotAccent,
                                    unfocusedBorderColor = VrotCard
                                ),
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        Spacer(modifier = Modifier.height(10.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { legalAccepted = !legalAccepted }
                        ) {
                            Checkbox(
                                checked = legalAccepted,
                                onCheckedChange = { legalAccepted = it },
                                colors = CheckboxDefaults.colors(checkedColor = VrotAccent)
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Text(
                                "Мне не менее $minAge лет, я принимаю условия и политику",
                                color = VrotTextPrimary,
                                fontSize = 12.sp,
                                modifier = Modifier.weight(1f)
                            )
                        }
                    }
                    "reset-request" -> {
                        OutlinedTextField(
                            value = email,
                            onValueChange = { email = it },
                            label = { Text("Email для сброса") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        TextButton(onClick = {
                            mode = "login"
                            error = ""
                            notice = ""
                        }) {
                            Text("← Вернуться ко входу", color = VrotTextSecondary, fontSize = 13.sp)
                        }
                    }
                    "reset-confirm" -> {
                        Text(
                            text = "Код отправлен на $email (действует 10 мин.)",
                            color = VrotTextSecondary,
                            fontSize = 13.sp
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = resetCode,
                            onValueChange = { resetCode = it },
                            label = { Text("6-значный код из письма") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(10.dp))
                        OutlinedTextField(
                            value = newPassword,
                            onValueChange = { newPassword = it },
                            label = { Text("Новый пароль (мин. 12 симв.)") },
                            visualTransformation = PasswordVisualTransformation(),
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White,
                                focusedBorderColor = VrotAccent,
                                unfocusedBorderColor = VrotCard
                            ),
                            modifier = Modifier.fillMaxWidth()
                        )
                        Spacer(modifier = Modifier.height(6.dp))
                        TextButton(onClick = {
                            mode = "reset-request"
                            error = ""
                        }) {
                            Text("Отправить код повторно", color = VrotAccent, fontSize = 13.sp)
                        }
                    }
                }

                if (error.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(text = error, color = VrotRed, fontSize = 13.sp)
                }
                if (notice.isNotEmpty()) {
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(text = notice, color = VrotGreen, fontSize = 13.sp)
                }

                Spacer(modifier = Modifier.height(16.dp))

                Button(
                    onClick = {
                        scope.launch {
                            loading = true
                            error = ""
                            notice = ""
                            try {
                                when (mode) {
                                    "login" -> {
                                        val body = JSONObject()
                                            .put("email", email.trim().lowercase())
                                            .put("password", password)
                                        api.obj("/api/auth/login", "POST", body)
                                        onLoggedIn()
                                    }
                                    "register" -> {
                                        val body = JSONObject()
                                            .put("username", username.trim())
                                            .put("email", email.trim().lowercase())
                                            .put("password", password)
                                            .put("birthDate", birthDate.trim())
                                            .put("legalAccepted", legalAccepted)
                                        api.obj("/api/auth/register", "POST", body)
                                        onLoggedIn()
                                    }
                                    "reset-request" -> {
                                        val body = JSONObject().put("email", email.trim().lowercase())
                                        val res = api.obj("/api/auth/password-reset/request", "POST", body)
                                        notice = res.optString("message", "Код отправлен на почту")
                                        mode = "reset-confirm"
                                    }
                                    "reset-confirm" -> {
                                        val body = JSONObject()
                                            .put("email", email.trim().lowercase())
                                            .put("code", resetCode.trim())
                                            .put("newPassword", newPassword)
                                        api.obj("/api/auth/password-reset/confirm", "POST", body)
                                        notice = "Пароль изменён. Теперь войдите с новым паролем."
                                        mode = "login"
                                        password = ""
                                    }
                                }
                            } catch (e: Exception) {
                                error = e.message ?: "Произошла ошибка"
                            } finally {
                                loading = false
                            }
                        }
                    },
                    enabled = !loading && when (mode) {
                        "login" -> email.isNotBlank() && password.isNotBlank()
                        "register" -> username.isNotBlank() && email.isNotBlank() && password.isNotBlank() && birthDate.isNotBlank() && legalAccepted
                        "reset-request" -> email.isNotBlank()
                        "reset-confirm" -> resetCode.isNotBlank() && newPassword.isNotBlank()
                        else -> false
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = VrotAccent),
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                ) {
                    if (loading) {
                        CircularProgressIndicator(color = Color.White, modifier = Modifier.size(24.dp))
                    } else {
                        Text(
                            when (mode) {
                                "login" -> "Войти"
                                "register" -> "Создать аккаунт"
                                "reset-request" -> "Отправить код"
                                else -> "Изменить пароль"
                            },
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun MainSocialScreen(
    app: VrotApplication,
    currentUser: JSONObject?,
    initialDm: String?,
    initialChannel: String?,
    onLogout: () -> Unit
) {
    var selectedTab by remember { mutableStateOf(0) } // 0: Друзья / ЛС, 1: Сообщества, 2: Профиль
    var activeChatFriend by remember { mutableStateOf<JSONObject?>(null) }
    var activeCommunityChannel by remember { mutableStateOf<Pair<JSONObject, JSONObject>?>(null) } // Community, Channel

    val realtime = app.realtime
    val api = app.api

    // Set initial target if opened from push notification
    LaunchedEffect(initialDm) {
        if (!initialDm.isNullOrBlank()) {
            try {
                val fList = api.array("/api/friends").objects()
                val found = fList.firstOrNull { it.optString("id") == initialDm }
                if (found != null) {
                    activeChatFriend = found
                }
            } catch (_: Exception) {}
        }
    }

    if (activeChatFriend != null) {
        ChatDirectScreen(
            app = app,
            friend = activeChatFriend!!,
            onBack = { activeChatFriend = null },
            onCall = { isVideo ->
                val fId = activeChatFriend!!.optString("id")
                val fName = activeChatFriend!!.optString("displayName").ifBlank { activeChatFriend!!.optString("username") }
                app.calls.outgoing(fId, fName, isVideo)
            }
        )
    } else if (activeCommunityChannel != null) {
        ChatChannelScreen(
            app = app,
            community = activeCommunityChannel!!.first,
            channel = activeCommunityChannel!!.second,
            onBack = { activeCommunityChannel = null }
        )
    } else {
        Scaffold(
            bottomBar = {
                Surface(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    shape = RoundedCornerShape(30.dp),
                    color = VrotSurface.copy(alpha = 0.96f),
                    tonalElevation = 8.dp,
                    shadowElevation = 16.dp
                ) {
                NavigationBar(containerColor = Color.Transparent) {
                    NavigationBarItem(
                        selected = selectedTab == 0,
                        onClick = { selectedTab = 0 },
                        icon = { Icon(Icons.Default.Chat, contentDescription = "ЛС и Друзья") },
                        label = { Text("Чаты") },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = VrotAccent,
                            selectedTextColor = VrotAccent,
                            indicatorColor = VrotAccent.copy(alpha = 0.18f)
                        )
                    )
                    NavigationBarItem(
                        selected = selectedTab == 1,
                        onClick = { selectedTab = 1 },
                        icon = { Icon(Icons.Default.Group, contentDescription = "Сообщества") },
                        label = { Text("Сообщества") },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = VrotAccent,
                            selectedTextColor = VrotAccent,
                            indicatorColor = VrotAccent.copy(alpha = 0.18f)
                        )
                    )
                    NavigationBarItem(
                        selected = selectedTab == 2,
                        onClick = { selectedTab = 2 },
                        icon = { Icon(Icons.Default.Person, contentDescription = "Профиль") },
                        label = { Text("Профиль") },
                        colors = NavigationBarItemDefaults.colors(
                            selectedIconColor = VrotAccent,
                            selectedTextColor = VrotAccent,
                            indicatorColor = VrotAccent.copy(alpha = 0.18f)
                        )
                    )
                }
                }
            }
        ) { padding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .background(VrotDarkBg)
            ) {
                when (selectedTab) {
                    0 -> FriendsListTab(
                        app = app,
                        onOpenChat = { activeChatFriend = it },
                        onCallFriend = { f, video ->
                            val fId = f.optString("id")
                            val fName = f.optString("displayName").ifBlank { f.optString("username") }
                            app.calls.outgoing(fId, fName, video)
                        }
                    )
                    1 -> CommunitiesTab(
                        app = app,
                        onOpenChannel = { comm, ch -> activeCommunityChannel = Pair(comm, ch) }
                    )
                    2 -> ProfileTab(
                        user = currentUser,
                        onLogout = onLogout
                    )
                }
            }
        }
    }
}

@Composable
fun FriendsListTab(
    app: VrotApplication,
    onOpenChat: (JSONObject) -> Unit,
    onCallFriend: (JSONObject, Boolean) -> Unit
) {
    var friends by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var selectedSubtab by remember { mutableStateOf(0) } // 0: В сети, 1: Все, 2: Ожидание, 3: Добавить
    var addUsername by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var isSearching by remember { mutableStateOf(false) }
    var actionNotice by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    val loadFriends = {
        scope.launch {
            loading = true
            try {
                friends = app.api.array("/api/friends").objects()
            } catch (_: Exception) {} finally {
                loading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        loadFriends()
        app.realtime.onFriendChange = { loadFriends() }
    }

    val acceptedFriends = remember(friends) {
        friends.filter { it.optString("status") == "accepted" }
    }
    val onlineFriends = remember(acceptedFriends) {
        acceptedFriends.filter { it.optString("presence") == "online" }
    }
    val pendingIncoming = remember(friends) {
        friends.filter { it.optString("status") == "pending" && it.optString("direction") == "incoming" }
    }
    val pendingOutgoing = remember(friends) {
        friends.filter { it.optString("status") == "pending" && it.optString("direction") == "outgoing" }
    }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Друзья", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)

        Spacer(modifier = Modifier.height(14.dp))

        // Subtabs: В сети | Все | Ожидание | Добавить
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            val tabs = listOf(
                "В сети (${onlineFriends.size})",
                "Все (${acceptedFriends.size})",
                "Ожидание (${pendingIncoming.size + pendingOutgoing.size})",
                "+ Добавить"
            )
            tabs.forEachIndexed { index, title ->
                val isSelected = selectedSubtab == index
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isSelected) VrotCard else VrotSurface)
                        .clickable { selectedSubtab = index; actionNotice = "" }
                        .padding(horizontal = 10.dp, vertical = 7.dp)
                ) {
                    Text(
                        title,
                        color = if (isSelected) (if (index == 3) VrotGreen else Color.White) else VrotTextSecondary,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }

        if (actionNotice.isNotBlank()) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(actionNotice, color = VrotAccent, fontSize = 12.sp)
        }

        Spacer(modifier = Modifier.height(14.dp))

        if (loading && friends.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = VrotAccent)
            }
        } else {
            when (selectedSubtab) {
                0 -> {
                    // В сети
                    if (onlineFriends.isEmpty()) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Никого из друзей нет в сети", color = VrotTextSecondary)
                        }
                    } else {
                        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(onlineFriends) { friend ->
                                FriendCardRow(
                                    friend = friend,
                                    onOpenChat = onOpenChat,
                                    onCallFriend = onCallFriend,
                                    onRemove = {
                                        scope.launch {
                                            runCatching { app.api.request("/api/friends/${friend.optString("id")}", "DELETE") }
                                            loadFriends()
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
                1 -> {
                    // Все друзья
                    if (acceptedFriends.isEmpty()) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Список друзей пуст. Найдите людей во вкладке «Добавить»", color = VrotTextSecondary)
                        }
                    } else {
                        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            items(acceptedFriends) { friend ->
                                FriendCardRow(
                                    friend = friend,
                                    onOpenChat = onOpenChat,
                                    onCallFriend = onCallFriend,
                                    onRemove = {
                                        scope.launch {
                                            runCatching { app.api.request("/api/friends/${friend.optString("id")}", "DELETE") }
                                            loadFriends()
                                        }
                                    }
                                )
                            }
                        }
                    }
                }
                2 -> {
                    // Ожидание (Входящие и Исходящие)
                    if (pendingIncoming.isEmpty() && pendingOutgoing.isEmpty()) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Нет ожидающих заявок в друзья", color = VrotTextSecondary)
                        }
                    } else {
                        LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            if (pendingIncoming.isNotEmpty()) {
                                item {
                                    Text("ВХОДЯЩИЕ ЗАЯВКИ — ${pendingIncoming.size}", color = VrotTextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                }
                                items(pendingIncoming) { item ->
                                    val name = item.optString("displayName").ifBlank { item.optString("username") }
                                    val id = item.optString("id")
                                    Card(
                                        modifier = Modifier.fillMaxWidth(),
                                        colors = CardDefaults.cardColors(containerColor = VrotSurface),
                                        shape = RoundedCornerShape(12.dp)
                                    ) {
                                        Row(
                                            modifier = Modifier.padding(12.dp),
                                            verticalAlignment = Alignment.CenterVertically
                                        ) {
                                            Box(
                                                modifier = Modifier.size(40.dp).background(VrotAccent, CircleShape),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
                                            }
                                            Spacer(modifier = Modifier.width(12.dp))
                                            Column(modifier = Modifier.weight(1f)) {
                                                Text(name, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                                                Text("Входящий запрос", color = VrotTextSecondary, fontSize = 12.sp)
                                            }
                                            Button(
                                                onClick = {
                                                    scope.launch {
                                                        runCatching { app.api.request("/api/friends/$id/accept", "POST") }
                                                        actionNotice = "Заявка принята"
                                                        loadFriends()
                                                    }
                                                },
                                                colors = ButtonDefaults.buttonColors(containerColor = VrotGreen),
                                                shape = RoundedCornerShape(8.dp)
                                            ) {
                                                Text("Принять", fontSize = 12.sp)
                                            }
                                            Spacer(modifier = Modifier.width(6.dp))
                                            Button(
                                                onClick = {
                                                    scope.launch {
                                                        runCatching { app.api.request("/api/friends/$id", "DELETE") }
                                                        actionNotice = "Заявка отклонена"
                                                        loadFriends()
                                                    }
                                                },
                                                colors = ButtonDefaults.buttonColors(containerColor = VrotRed),
                                                shape = RoundedCornerShape(8.dp)
                                            ) {
                                                Text("Отклонить", fontSize = 12.sp)
                                            }
                                        }
                                    }
                                }
                            }

                            if (pendingOutgoing.isNotEmpty()) {
                                item {
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text("ИСХОДЯЩИЕ ЗАЯВКИ — ${pendingOutgoing.size}", color = VrotTextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                }
                                items(pendingOutgoing) { item ->
                                    val name = item.optString("displayName").ifBlank { item.optString("username") }
                                    val id = item.optString("id")
                                    Card(
                                        modifier = Modifier.fillMaxWidth(),
                                        colors = CardDefaults.cardColors(containerColor = VrotSurface),
                                        shape = RoundedCornerShape(12.dp)
                                    ) {
                                        Row(
                                            modifier = Modifier.padding(12.dp),
                                            verticalAlignment = Alignment.CenterVertically
                                        ) {
                                            Box(
                                                modifier = Modifier.size(40.dp).background(VrotAccent, CircleShape),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
                                            }
                                            Spacer(modifier = Modifier.width(12.dp))
                                            Column(modifier = Modifier.weight(1f)) {
                                                Text(name, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                                                Text("Ожидает ответа", color = VrotTextSecondary, fontSize = 12.sp)
                                            }
                                            Button(
                                                onClick = {
                                                    scope.launch {
                                                        runCatching { app.api.request("/api/friends/$id", "DELETE") }
                                                        actionNotice = "Заявка отменена"
                                                        loadFriends()
                                                    }
                                                },
                                                colors = ButtonDefaults.buttonColors(containerColor = VrotCard),
                                                shape = RoundedCornerShape(8.dp)
                                            ) {
                                                Text("Отменить", color = VrotRed, fontSize = 12.sp)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                3 -> {
                    // Добавить в друзья (поиск по имени)
                    Column(modifier = Modifier.fillMaxSize()) {
                        Text("ДОБАВИТЬ В ДРУЗЬЯ", color = VrotTextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Spacer(modifier = Modifier.height(4.dp))
                        Text("Вы можете добавить друга по его точному имени пользователя.", color = VrotTextSecondary, fontSize = 13.sp)

                        Spacer(modifier = Modifier.height(12.dp))

                        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(
                                value = addUsername,
                                onValueChange = { addUsername = it },
                                label = { Text("Имя пользователя") },
                                singleLine = true,
                                colors = OutlinedTextFieldDefaults.colors(
                                    focusedTextColor = Color.White,
                                    unfocusedTextColor = Color.White,
                                    focusedBorderColor = VrotAccent,
                                    unfocusedBorderColor = VrotCard
                                ),
                                modifier = Modifier.weight(1f)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Button(
                                onClick = {
                                    if (addUsername.isNotBlank()) {
                                        scope.launch {
                                            isSearching = true
                                            try {
                                                searchResults = app.api.array("/api/users/search?q=${addUsername.trim()}").objects()
                                                if (searchResults.isEmpty()) {
                                                    actionNotice = "Пользователи не найдены"
                                                }
                                            } catch (e: Exception) {
                                                actionNotice = e.message ?: "Ошибка поиска"
                                            } finally {
                                                isSearching = false
                                            }
                                        }
                                    }
                                },
                                enabled = addUsername.isNotBlank() && !isSearching,
                                colors = ButtonDefaults.buttonColors(containerColor = VrotAccent),
                                shape = RoundedCornerShape(10.dp),
                                modifier = Modifier.height(54.dp)
                            ) {
                                if (isSearching) {
                                    CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp))
                                } else {
                                    Text("Найти")
                                }
                            }
                        }

                        if (searchResults.isNotEmpty()) {
                            Spacer(modifier = Modifier.height(16.dp))
                            Text("РЕЗУЛЬТАТЫ ПОИСКА", color = VrotTextSecondary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                            Spacer(modifier = Modifier.height(8.dp))

                            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                items(searchResults) { user ->
                                    val uName = user.optString("username")
                                    val dName = user.optString("displayName").ifBlank { uName }
                                    Card(
                                        modifier = Modifier.fillMaxWidth(),
                                        colors = CardDefaults.cardColors(containerColor = VrotSurface),
                                        shape = RoundedCornerShape(12.dp)
                                    ) {
                                        Row(
                                            modifier = Modifier.padding(12.dp),
                                            verticalAlignment = Alignment.CenterVertically
                                        ) {
                                            Box(
                                                modifier = Modifier.size(40.dp).background(VrotAccent, CircleShape),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(dName.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
                                            }
                                            Spacer(modifier = Modifier.width(12.dp))
                                            Column(modifier = Modifier.weight(1f)) {
                                                Text(dName, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                                                Text("@$uName", color = VrotTextSecondary, fontSize = 12.sp)
                                            }
                                            Button(
                                                onClick = {
                                                    scope.launch {
                                                        runCatching {
                                                            app.api.request("/api/friends/requests", "POST", JSONObject().put("username", uName))
                                                            actionNotice = "Заявка отправлена пользователю $uName"
                                                            loadFriends()
                                                            searchResults = searchResults.filter { it.optString("username") != uName }
                                                        }.onFailure {
                                                            actionNotice = it.message ?: "Ошибка отправки"
                                                        }
                                                    }
                                                },
                                                colors = ButtonDefaults.buttonColors(containerColor = VrotAccent),
                                                shape = RoundedCornerShape(8.dp)
                                            ) {
                                                Text("Добавить", fontSize = 12.sp)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun FriendCardRow(
    friend: JSONObject,
    onOpenChat: (JSONObject) -> Unit,
    onCallFriend: (JSONObject, Boolean) -> Unit,
    onRemove: () -> Unit
) {
    val name = friend.optString("displayName").ifBlank { friend.optString("username") }
    val presence = friend.optString("presence", "offline")

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onOpenChat(friend) },
        colors = CardDefaults.cardColors(containerColor = VrotSurface),
        shape = RoundedCornerShape(12.dp)
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(46.dp)
                    .background(VrotAccent, CircleShape),
                contentAlignment = Alignment.Center
            ) {
                Text(name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }

            Spacer(modifier = Modifier.width(14.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(name, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                Text(
                    text = if (presence == "online") "В сети" else "Не в сети",
                    color = if (presence == "online") VrotGreen else VrotTextSecondary,
                    fontSize = 12.sp
                )
            }

            IconButton(onClick = { onCallFriend(friend, false) }) {
                Icon(Icons.Default.Call, contentDescription = "Аудиозвонок", tint = VrotGreen)
            }
            IconButton(onClick = { onCallFriend(friend, true) }) {
                Icon(Icons.Default.Videocam, contentDescription = "Видеозвонок", tint = VrotAccent)
            }
            IconButton(onClick = onRemove) {
                Icon(Icons.Default.Close, contentDescription = "Удалить", tint = VrotRed)
            }
        }
    }
}

@Composable
fun CommunitiesTab(
    app: VrotApplication,
    onOpenChannel: (JSONObject, JSONObject) -> Unit
) {
    var communities by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selectedCommunity by remember { mutableStateOf<JSONObject?>(null) }
    var channels by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        scope.launch {
            try {
                communities = app.api.array("/api/communities").objects()
                if (communities.isNotEmpty()) {
                    selectedCommunity = communities.first()
                }
            } catch (_: Exception) {} finally {
                loading = false
            }
        }
    }

    LaunchedEffect(selectedCommunity) {
        val commId = selectedCommunity?.optString("id") ?: return@LaunchedEffect
        try {
            channels = app.api.array("/api/communities/$commId/channels").objects()
        } catch (_: Exception) {}
    }

    Row(modifier = Modifier.fillMaxSize()) {
        // Community left rail
        Column(
            modifier = Modifier
                .width(72.dp)
                .fillMaxHeight()
                .background(VrotSurface)
                .padding(vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            communities.forEach { comm ->
                val isSelected = comm.optString("id") == selectedCommunity?.optString("id")
                Box(
                    modifier = Modifier
                        .size(48.dp)
                        .clip(if (isSelected) RoundedCornerShape(14.dp) else CircleShape)
                        .background(if (isSelected) VrotAccent else VrotCard)
                        .clickable { selectedCommunity = comm },
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = comm.optString("name").take(1).uppercase(),
                        color = Color.White,
                        fontWeight = FontWeight.Bold
                    )
                }
                Spacer(modifier = Modifier.height(10.dp))
            }
        }

        // Channels column
        var showAddChannelDialog by remember { mutableStateOf(false) }
        var showCreateCommunityDialog by remember { mutableStateOf(false) }
        var showJoinByCodeDialog by remember { mutableStateOf(false) }
        var inviteCodeInput by remember { mutableStateOf("") }
        var invitations by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
        var communityNotice by remember { mutableStateOf("") }
        var newChannelName by remember { mutableStateOf("") }
        var newChannelKind by remember { mutableStateOf("text") }
        var newCommunityName by remember { mutableStateOf("") }
        var newCommunityDesc by remember { mutableStateOf("") }

        val loadInvitations = {
            scope.launch {
                try {
                    invitations = app.api.array("/api/community-invitations").objects()
                } catch (_: Exception) {}
            }
        }

        LaunchedEffect(Unit) {
            loadInvitations()
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(VrotDarkBg)
                .padding(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = selectedCommunity?.optString("name") ?: "Сообщества",
                    color = Color.White,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.weight(1f)
                )
                Button(
                    onClick = { showJoinByCodeDialog = true },
                    colors = ButtonDefaults.buttonColors(containerColor = VrotCard),
                    shape = RoundedCornerShape(8.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                    modifier = Modifier.height(34.dp)
                ) {
                    Text("По коду", color = VrotAccent, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
                Spacer(modifier = Modifier.width(6.dp))
                if (selectedCommunity != null) {
                    IconButton(onClick = { showAddChannelDialog = true }) {
                        Icon(Icons.Default.Add, contentDescription = "Добавить канал", tint = VrotAccent)
                    }
                }
                IconButton(onClick = { showCreateCommunityDialog = true }) {
                    Icon(Icons.Default.GroupAdd, contentDescription = "Создать сообщество", tint = VrotAccent)
                }
            }

            if (communityNotice.isNotBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(communityNotice, color = VrotAccent, fontSize = 12.sp)
            }

            // Invitations banner
            if (invitations.isNotEmpty()) {
                Spacer(modifier = Modifier.height(10.dp))
                Text("ПРИГЛАШЕНИЯ В СООБЩЕСТВА", color = VrotTextSecondary, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                Spacer(modifier = Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    invitations.forEach { inv ->
                        val invId = inv.optString("id")
                        val cName = inv.optString("communityName")
                        val inviter = inv.optString("inviterUsername")
                        Card(
                            modifier = Modifier.fillMaxWidth(),
                            colors = CardDefaults.cardColors(containerColor = VrotSurface),
                            shape = RoundedCornerShape(10.dp)
                        ) {
                            Row(
                                modifier = Modifier.padding(10.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(cName, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    Text("От @$inviter", color = VrotTextSecondary, fontSize = 11.sp)
                                }
                                Button(
                                    onClick = {
                                        scope.launch {
                                            runCatching {
                                                val body = JSONObject().put("accept", true)
                                                app.api.request("/api/community-invitations/$invId/respond", "POST", body)
                                                communityNotice = "Вы вступили в сообщество!"
                                                communities = app.api.array("/api/communities").objects()
                                                loadInvitations()
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = VrotGreen),
                                    shape = RoundedCornerShape(6.dp),
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                                    modifier = Modifier.height(30.dp)
                                ) {
                                    Text("Вступить", fontSize = 11.sp)
                                }
                                Spacer(modifier = Modifier.width(4.dp))
                                Button(
                                    onClick = {
                                        scope.launch {
                                            runCatching {
                                                val body = JSONObject().put("accept", false)
                                                app.api.request("/api/community-invitations/$invId/respond", "POST", body)
                                                loadInvitations()
                                            }
                                        }
                                    },
                                    colors = ButtonDefaults.buttonColors(containerColor = VrotCard),
                                    shape = RoundedCornerShape(6.dp),
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                                    modifier = Modifier.height(30.dp)
                                ) {
                                    Text("Отклонить", color = VrotTextSecondary, fontSize = 11.sp)
                                }
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(14.dp))

            if (channels.isEmpty() && selectedCommunity != null) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("В этом сообществе пока нет каналов", color = VrotTextSecondary)
                }
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(channels) { channel ->
                        val kind = channel.optString("kind", "text")
                        val isVoice = kind == "voice"
                        Card(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (isVoice) {
                                        app.calls.joinChannel(channel.optString("id"), channel.optString("name"))
                                    } else {
                                        selectedCommunity?.let { onOpenChannel(it, channel) }
                                    }
                                },
                            colors = CardDefaults.cardColors(containerColor = VrotSurface),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Row(
                                modifier = Modifier.padding(12.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Icon(
                                    imageVector = if (isVoice) Icons.Default.VolumeUp else Icons.Default.Tag,
                                    contentDescription = null,
                                    tint = if (isVoice) VrotGreen else VrotTextSecondary,
                                    modifier = Modifier.size(18.dp)
                                )
                                Spacer(modifier = Modifier.width(10.dp))
                                Text(channel.optString("name"), color = VrotTextPrimary, fontSize = 15.sp)
                            }
                        }
                    }
                }
            }
        }

        if (showJoinByCodeDialog) {
            AlertDialog(
                onDismissRequest = { showJoinByCodeDialog = false },
                title = { Text("Присоединиться по коду", color = Color.White) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Введите 8-значный код приглашения:", color = VrotTextSecondary, fontSize = 13.sp)
                        OutlinedTextField(
                            value = inviteCodeInput,
                            onValueChange = { inviteCodeInput = it },
                            label = { Text("Код приглашения") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            )
                        )
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            val code = inviteCodeInput.trim()
                            if (code.isNotBlank()) {
                                scope.launch {
                                    runCatching {
                                        app.api.request("/api/invites/$code/join", "POST")
                                        communityNotice = "Вы успешно присоединились!"
                                        communities = app.api.array("/api/communities").objects()
                                        if (communities.isNotEmpty()) selectedCommunity = communities.last()
                                        showJoinByCodeDialog = false
                                        inviteCodeInput = ""
                                    }.onFailure {
                                        communityNotice = it.message ?: "Неверный код приглашения"
                                    }
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VrotAccent)
                    ) { Text("Присоединиться") }
                },
                dismissButton = {
                    TextButton(onClick = { showJoinByCodeDialog = false }) { Text("Отмена", color = VrotTextSecondary) }
                },
                containerColor = VrotSurface
            )
        }

        if (showAddChannelDialog && selectedCommunity != null) {
            val commId = selectedCommunity!!.optString("id")
            AlertDialog(
                onDismissRequest = { showAddChannelDialog = false },
                title = { Text("Новый канал", color = Color.White) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(
                            value = newChannelName,
                            onValueChange = { newChannelName = it },
                            label = { Text("Название канала") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            )
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(
                                selected = newChannelKind == "text",
                                onClick = { newChannelKind = "text" }
                            )
                            Text("Текстовый", color = Color.White)
                            Spacer(modifier = Modifier.width(16.dp))
                            RadioButton(
                                selected = newChannelKind == "voice",
                                onClick = { newChannelKind = "voice" }
                            )
                            Text("Голосовой", color = Color.White)
                        }
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            if (newChannelName.isNotBlank()) {
                                scope.launch {
                                    runCatching {
                                        val body = JSONObject().put("name", newChannelName).put("kind", newChannelKind)
                                        app.api.request("/api/communities/$commId/channels", "POST", body)
                                        channels = app.api.array("/api/communities/$commId/channels").objects()
                                    }
                                    newChannelName = ""
                                    showAddChannelDialog = false
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VrotAccent)
                    ) { Text("Создать") }
                },
                dismissButton = {
                    TextButton(onClick = { showAddChannelDialog = false }) { Text("Отмена", color = VrotTextSecondary) }
                },
                containerColor = VrotSurface
            )
        }

        if (showCreateCommunityDialog) {
            AlertDialog(
                onDismissRequest = { showCreateCommunityDialog = false },
                title = { Text("Создать сообщество", color = Color.White) },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedTextField(
                            value = newCommunityName,
                            onValueChange = { newCommunityName = it },
                            label = { Text("Название") },
                            singleLine = true,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            )
                        )
                        OutlinedTextField(
                            value = newCommunityDesc,
                            onValueChange = { newCommunityDesc = it },
                            label = { Text("Описание") },
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedTextColor = Color.White,
                                unfocusedTextColor = Color.White
                            )
                        )
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            if (newCommunityName.isNotBlank()) {
                                scope.launch {
                                    runCatching {
                                        val body = JSONObject().put("name", newCommunityName).put("description", newCommunityDesc)
                                        val created = app.api.obj("/api/communities", "POST", body)
                                        communities = communities + created
                                        selectedCommunity = created
                                    }
                                    newCommunityName = ""
                                    newCommunityDesc = ""
                                    showCreateCommunityDialog = false
                                }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = VrotAccent)
                    ) { Text("Создать") }
                },
                dismissButton = {
                    TextButton(onClick = { showCreateCommunityDialog = false }) { Text("Отмена", color = VrotTextSecondary) }
                },
                containerColor = VrotSurface
            )
        }
    }
}

@Composable
fun ProfileTab(user: JSONObject?, onLogout: () -> Unit) {
    val name = user?.optString("displayName")?.ifBlank { user.optString("username") } ?: "Пользователь"
    val username = user?.optString("username").orEmpty()
    val bio = user?.optString("bio").orEmpty()
    val verified = user?.optBoolean("verified") ?: false
    val donator = user?.optBoolean("donator") ?: false

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(20.dp))

        Box(
            modifier = Modifier
                .size(90.dp)
                .background(VrotAccent, CircleShape),
            contentAlignment = Alignment.Center
        ) {
            Text(name.take(1).uppercase(), color = Color.White, fontSize = 36.sp, fontWeight = FontWeight.Bold)
        }

        Spacer(modifier = Modifier.height(16.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(name, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            if (verified) {
                Spacer(modifier = Modifier.width(6.dp))
                Icon(Icons.Default.CheckCircle, contentDescription = "Верифицирован", tint = VrotAccent, modifier = Modifier.size(20.dp))
            }
            if (donator) {
                Spacer(modifier = Modifier.width(4.dp))
                Icon(Icons.Default.Star, contentDescription = "Донатер", tint = Color(0xFFFFD700), modifier = Modifier.size(20.dp))
            }
        }
        Text("@$username", color = VrotTextSecondary, fontSize = 14.sp)

        if (bio.isNotBlank()) {
            Spacer(modifier = Modifier.height(12.dp))
            Card(
                colors = CardDefaults.cardColors(containerColor = VrotSurface),
                shape = RoundedCornerShape(10.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(14.dp)) {
                    Text("О себе", color = VrotTextSecondary, fontSize = 12.sp)
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(bio, color = VrotTextPrimary, fontSize = 14.sp)
                }
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        Button(
            onClick = onLogout,
            colors = ButtonDefaults.buttonColors(containerColor = VrotRed),
            shape = RoundedCornerShape(10.dp),
            modifier = Modifier.fillMaxWidth().height(48.dp)
        ) {
            Text("Выйти из аккаунта", fontSize = 16.sp)
        }

        Spacer(modifier = Modifier.height(16.dp))
    }
}

@Composable
fun ChatDirectScreen(
    app: VrotApplication,
    friend: JSONObject,
    onBack: () -> Unit,
    onCall: (Boolean) -> Unit
) {
    val friendId = friend.optString("id")
    val friendName = friend.optString("displayName").ifBlank { friend.optString("username") }
    var messages by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var textInput by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    LaunchedEffect(friendId) {
        try {
            messages = app.api.array("/api/friends/$friendId/messages").objects()
        } catch (_: Exception) {}

        app.realtime.onDirectMessage = { msg ->
            if (msg.optJSONObject("author")?.optString("id") == friendId ||
                msg.optString("recipientId") == friendId) {
                messages = messages + msg
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(VrotDarkBg)) {
        // Chat Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(VrotSurface)
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Default.ArrowBack, contentDescription = "Назад", tint = Color.White)
            }
            Text(
                friendName,
                color = Color.White,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
            IconButton(onClick = { onCall(false) }) {
                Icon(Icons.Default.Call, contentDescription = "Аудиозвонок", tint = VrotAccent)
            }
            IconButton(onClick = { onCall(true) }) {
                Icon(Icons.Default.Videocam, contentDescription = "Видеозвонок", tint = VrotAccent)
            }
        }

        // Messages List
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(messages) { msg ->
                val author = msg.optJSONObject("author")
                val isMe = author?.optString("id") != friendId
                val content = msg.optString("content")

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start
                ) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(12.dp))
                            .background(if (isMe) VrotAccent else VrotSurface)
                            .padding(12.dp)
                            .widthIn(max = 280.dp)
                    ) {
                        Text(content, color = Color.White, fontSize = 15.sp)
                    }
                }
            }
        }

        // Input bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(VrotSurface)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = textInput,
                onValueChange = { textInput = it },
                placeholder = { Text("Сообщение…", color = VrotTextSecondary) },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                ),
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(
                onClick = {
                    if (textInput.isNotBlank()) {
                        val toSend = textInput
                        textInput = ""
                        scope.launch {
                            try {
                                val body = JSONObject().put("content", toSend)
                                val created = app.api.obj("/api/friends/$friendId/messages", "POST", body)
                                messages = messages + created
                            } catch (_: Exception) {}
                        }
                    }
                }
            ) {
                Icon(Icons.Default.Send, contentDescription = "Отправить", tint = VrotAccent)
            }
        }
    }
}

@Composable
fun ChatChannelScreen(
    app: VrotApplication,
    community: JSONObject,
    channel: JSONObject,
    onBack: () -> Unit
) {
    val channelId = channel.optString("id")
    val channelName = channel.optString("name")
    var messages by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var textInput by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    LaunchedEffect(channelId) {
        app.realtime.joinChannel(channelId)
        try {
            messages = app.api.array("/api/channels/$channelId/messages").objects()
        } catch (_: Exception) {}

        app.realtime.onChannelMessage = { msg ->
            if (msg.optString("channelId") == channelId) {
                messages = messages + msg
            }
        }
    }

    Column(modifier = Modifier.fillMaxSize().background(VrotDarkBg)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(VrotSurface)
                .padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.Default.ArrowBack, contentDescription = "Назад", tint = Color.White)
            }
            Text(
                "# $channelName",
                color = Color.White,
                fontSize = 18.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f)
            )
        }

        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(messages) { msg ->
                val author = msg.optJSONObject("author")
                val authorName = author?.optString("displayName")?.ifBlank { author.optString("username") } ?: "Пользователь"
                val content = msg.optString("content")

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(VrotSurface)
                        .padding(10.dp)
                ) {
                    Text(authorName, color = VrotAccent, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(content, color = Color.White, fontSize = 15.sp)
                }
            }
        }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(VrotSurface)
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedTextField(
                value = textInput,
                onValueChange = { textInput = it },
                placeholder = { Text("Отправить в #$channelName", color = VrotTextSecondary) },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White
                ),
                modifier = Modifier.weight(1f)
            )
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(
                onClick = {
                    if (textInput.isNotBlank()) {
                        val toSend = textInput
                        textInput = ""
                        scope.launch {
                            try {
                                val body = JSONObject().put("content", toSend)
                                app.api.request("/api/channels/$channelId/messages", "POST", body)
                            } catch (_: Exception) {}
                        }
                    }
                }
            ) {
                Icon(Icons.Default.Send, contentDescription = "Отправить", tint = VrotAccent)
            }
        }
    }
}

@Composable
fun ActiveCallOverlay(app: VrotApplication) {
    val callState by app.calls.state.collectAsState()
    val remoteVideos by app.calls.remoteVideos.collectAsState()

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = Color(0xFF0F121C)
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            // Video views if video call
            if (callState.video && remoteVideos.isNotEmpty()) {
                val firstTrack = remoteVideos.values.first()
                AndroidView(
                    factory = { ctx ->
                        SurfaceViewRenderer(ctx).apply {
                            init(app.calls.egl.eglBaseContext, null)
                            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FILL)
                            firstTrack.addSink(this)
                        }
                    },
                    modifier = Modifier.fillMaxSize()
                )
            } else {
                // Audio call presentation
                Column(
                    modifier = Modifier
                        .align(Alignment.Center)
                        .padding(bottom = 60.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Box(
                        modifier = Modifier
                            .size(110.dp)
                            .background(VrotAccent, CircleShape),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            callState.label.take(1).uppercase(),
                            color = Color.White,
                            fontSize = 44.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }
                    Spacer(modifier = Modifier.height(20.dp))
                    Text(
                        callState.label,
                        color = Color.White,
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        callState.status,
                        color = VrotTextSecondary,
                        fontSize = 15.sp
                    )
                }
            }

            // Controls at bottom
            Row(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(bottom = 40.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(
                    onClick = { app.calls.mute() },
                    modifier = Modifier
                        .size(56.dp)
                        .background(if (callState.muted) VrotRed else VrotCard, CircleShape)
                ) {
                    Icon(
                        imageVector = if (callState.muted) Icons.Default.MicOff else Icons.Default.Mic,
                        contentDescription = "Микрофон",
                        tint = Color.White
                    )
                }

                IconButton(
                    onClick = { app.calls.end() },
                    modifier = Modifier
                        .size(64.dp)
                        .background(VrotRed, CircleShape)
                ) {
                    Icon(
                        imageVector = Icons.Default.CallEnd,
                        contentDescription = "Завершить",
                        tint = Color.White,
                        modifier = Modifier.size(32.dp)
                    )
                }
            }
        }
    }
}
