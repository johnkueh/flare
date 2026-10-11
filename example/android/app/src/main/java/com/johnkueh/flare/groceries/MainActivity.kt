package com.johnkueh.flare.groceries

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.johnkueh.sync.ffi.formatInvite
import kotlinx.coroutines.launch

/**
 * A shared grocery list on Flare, the same one as the web page in
 * `example/public`. It signs in as an anonymous user on first launch
 * (`FlareAuth`), keeps each list in the Rust store (`SyncStore`), and syncs
 * with `SyncPass` whenever the list's `LiveSocket` says to.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = AppModel(applicationContext)
        setContent {
            MaterialTheme {
                var open by remember { mutableStateOf<SavedList?>(null) }
                val list = open
                if (list == null) {
                    Home(app, onOpen = { open = it })
                } else {
                    BackHandler { open = null }
                    GroceryList(app, list, onBack = { open = null })
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Screen(title: String, onBack: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = { if (onBack != null) TextButton(onClick = onBack) { Text("All lists") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.padding(padding).imePadding().fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) { content() }
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
}

/** A text field with its button beside it. */
@Composable
private fun Entry(
    value: String, onValue: (String) -> Unit, label: String, button: String, onSubmit: () -> Unit,
    enabled: Boolean = value.isNotBlank(), keyboard: KeyboardOptions = KeyboardOptions.Default,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value, onValue, Modifier.weight(1f), label = { Text(label) }, singleLine = true,
            keyboardOptions = keyboard.copy(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (enabled) onSubmit() }),
        )
        Button(onClick = onSubmit, enabled = enabled) { Text(button) }
    }
}

/** Your lists, a new one or an invite code, and the account. */
@Composable
private fun Home(app: AppModel, onOpen: (SavedList) -> Unit) {
    val scope = rememberCoroutineScope()
    var newName by rememberSaveable { mutableStateOf("") }
    var inviteCode by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var code by rememberSaveable { mutableStateOf("") }
    var codeSent by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) { app.refresh() }

    Screen("Groceries") {
        Heading("Your lists")
        if (app.lists.isEmpty()) Text("No lists yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
        app.lists.forEach { list ->
            Text(list.name, Modifier.fillMaxWidth().clickable { onOpen(list) }.padding(vertical = 12.dp), style = MaterialTheme.typography.titleMedium)
            HorizontalDivider()
        }

        Heading("New list")
        Entry(newName, { newName = it }, "New list name", "Create", onSubmit = {
            scope.launch {
                app.create(newName.trim())?.let {
                    newName = ""
                    onOpen(it)
                }
            }
        })
        Entry(
            inviteCode, { inviteCode = it }, "Invite code", "Join",
            keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
            onSubmit = {
                scope.launch {
                    app.join(inviteCode)?.let {
                        inviteCode = ""
                        onOpen(it)
                    }
                }
            },
        )

        Heading("Account")
        val signedIn = app.email
        if (signedIn != null) {
            Text("Signed in as $signedIn")
            TextButton(onClick = { scope.launch { app.signOut() } }) { Text("Sign out") }
        } else {
            Text(
                "You're signed in anonymously on this phone. Sign in with an email code to keep your lists on an account and open them anywhere.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Entry(
                email, { email = it }, "you@example.com", "Send code", enabled = "@" in email,
                keyboard = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false),
                onSubmit = { scope.launch { codeSent = app.sendCode(email.trim()) } },
            )
            if (codeSent) {
                Entry(
                    code, { code = it }, "6-digit code", "Sign in", keyboard = KeyboardOptions(keyboardType = KeyboardType.Number),
                    onSubmit = {
                        scope.launch {
                            if (app.signIn(email.trim(), code.trim())) {
                                code = ""
                                codeSent = false
                            }
                        }
                    },
                )
            }
        }
        app.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** One list: its items, the invite code and who's in it. */
@Composable
private fun GroceryList(app: AppModel, list: SavedList, onBack: () -> Unit) {
    val context = LocalContext.current.applicationContext
    val model = remember(list.id) { ListModel(context, list.id, app.client) }
    DisposableEffect(model) {
        model.start()
        onDispose { model.stop() }
    }
    var newItem by rememberSaveable { mutableStateOf("") }

    Screen(list.name, onBack) {
        Entry(newItem, { newItem = it }, "Add an item", "Add", onSubmit = {
            model.add(newItem.trim())
            newItem = ""
        })
        model.items.forEach { item ->
            val done = item.done == true
            Row(Modifier.fillMaxWidth().clickable { model.toggle(item) }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked = done, onCheckedChange = { model.toggle(item) })
                Text(
                    item.name.orEmpty(),
                    textDecoration = if (done) TextDecoration.LineThrough else null,
                    color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        Text(
            model.error ?: if (model.isLive) "Live" else "Connecting…",
            style = MaterialTheme.typography.bodySmall,
            color = if (model.error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )

        model.info?.let { info ->
            Heading("Invite code")
            Text(formatInvite(info.code), fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleLarge)
            Heading("Members")
            info.devices.forEach { member ->
                Column {
                    Text((if (member.id == info.you) "You" else "Member") + if (member.id == info.owner) " (owner)" else "")
                    Text(
                        member.devices.joinToString { it.name.ifEmpty { it.platform } },
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
