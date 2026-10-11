package com.johnkueh.sync.client

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Accounts on a Flare server (`AUTH.md`), as the [SpaceTokens] a
 * [SpaceClient] takes, the Kotlin side of the Swift package's `FlareAuth`.
 * The phone signs in as an anonymous user the first time it needs a token,
 * proving with Android key attestation that it's a genuine copy of the
 * app. Signing in with Apple or an email code later links that user, so
 * nothing is lost.
 *
 * [baseUrl] is where the auth routes are mounted, e.g.
 * `https://api.example.com/v1/auth`. [allowUnattested] signs in without
 * attestation, for the emulator against a server with
 * `FLARE_AUTH_ALLOW_UNATTESTED` on.
 *
 * The session token, key id and signing counter live in the app's private
 * SharedPreferences. Encrypted storage would need androidx.security; the
 * token only opens this app's own spaces, and the signing key itself stays
 * in the Keystore.
 */
class FlareAuth(
    context: Context,
    baseUrl: String,
    private val allowUnattested: Boolean = false,
    private val http: OkHttpClient = SpaceClient.defaultHttp(),
    private val name: String = "flare.auth",
) : SpaceTokens {
    private val baseUrl = baseUrl.trimEnd('/')
    private val prefs = context.applicationContext.getSharedPreferences(name, Context.MODE_PRIVATE)
    private val anonymous = Mutex()
    private val alias = "$name.key"

    /** The attested key this install signs in with, once it has one. The
     *  server records it as the session's device. */
    val deviceId: String? get() = prefs.getString(KEY_ID, null)

    /** The stored session token, or a new anonymous user's. Many requests
     *  can ask at once on first launch; they share one sign-in. */
    override suspend fun token(): String =
        storedToken() ?: anonymous.withLock { storedToken() ?: signIn("/sign-in/anonymous", JsonObject(emptyMap())) }

    override fun clear() {
        prefs.edit().remove(TOKEN).apply()
    }

    /** Sign in with Apple's identity token (and the raw nonce, if the
     *  request had one). The anonymous user becomes this account. */
    suspend fun signInWithApple(idToken: String, nonce: String? = null): String =
        signIn("/sign-in/social", buildJsonObject {
            put("provider", "apple")
            putJsonObject("idToken") {
                put("token", idToken)
                if (nonce != null) put("nonce", nonce)
            }
        })

    /** Emails a sign-in code for [signInWithEmailCode]. */
    suspend fun sendEmailCode(email: String) {
        post("/email-otp/send-verification-otp", buildJsonObject {
            put("email", email)
            put("type", "sign-in")
        }).close()
    }

    /** Signs in with the emailed code. The anonymous user becomes this account. */
    suspend fun signInWithEmailCode(email: String, code: String): String =
        signIn("/sign-in/email-otp", buildJsonObject {
            put("email", email)
            put("otp", code)
        })

    /** Ends the session on the server and forgets it. The next [token]
     *  starts a new anonymous user. */
    suspend fun signOut() {
        val token = storedToken()
        if (token != null) {
            // Best effort: signed out on the phone either way.
            runCatching { post("/sign-out", JsonObject(emptyMap()), mapOf("Authorization" to "Bearer $token")).close() }
        }
        clear()
    }

    // Signing in

    /** POSTs a sign-in with a fresh signature (and the current session, so
     *  Better Auth links it), and keeps the token that comes back. A server
     *  that doesn't know the key gets a new one, once. */
    private suspend fun signIn(path: String, body: JsonObject): String =
        try {
            signInOnce(path, body)
        } catch (error: SpaceServerException) {
            if (error.code != "ATTESTATION_REQUIRED" || allowUnattested) throw error
            prefs.edit().remove(KEY_ID).apply()
            signInOnce(path, body)
        }

    private suspend fun signInOnce(path: String, body: JsonObject): String {
        val headers = attestationHeaders().toMutableMap()
        storedToken()?.let { headers["Authorization"] = "Bearer $it" }
        val token = post(path, body, headers).use { it.header("set-auth-token") }
        if (token.isNullOrEmpty()) throw SpaceServerException(200, "NO_TOKEN", null)
        prefs.edit().putString(TOKEN, token).apply()
        return token
    }

    /** `X-Attest-Challenge` and a Keystore signature over
     *  `SHA256(challenge) ‖ counter as 8 bytes big-endian`, or none when
     *  unattested. The counter goes up with every signature and is saved
     *  before it's used, so it never repeats. */
    private suspend fun attestationHeaders(): Map<String, String> {
        if (allowUnattested) return emptyMap()
        val keyId = registeredKey()
        val challenge = challenge()
        val (counter, signature) = withContext(Dispatchers.IO) {
            val counter = synchronized(this@FlareAuth) {
                (prefs.getLong(COUNTER, 0) + 1).also { prefs.edit().putLong(COUNTER, it).commit() }
            }
            val message = sha256(challenge.toByteArray(Charsets.UTF_8)) + ByteBuffer.allocate(8).putLong(counter).array()
            val key = keyStore().getKey(alias, null) as PrivateKey
            counter to Signature.getInstance("SHA256withECDSA").run {
                initSign(key)
                update(message)
                sign()
            }
        }
        return mapOf(
            "X-Attest-Challenge" to challenge,
            "X-Android-Key-Id" to keyId,
            "X-Android-Counter" to counter.toString(),
            "X-Android-Signature" to base64(signature),
        )
    }

    /** This install's Keystore key, registered with the server the first
     *  time it's needed. Its certificate chain carries SHA256(challenge),
     *  and its id is the SHA-256 of its public key (SubjectPublicKeyInfo). */
    private suspend fun registeredKey(): String {
        val saved = deviceId
        if (saved != null && withContext(Dispatchers.IO) { keyStore().containsAlias(alias) }) return saved
        val challenge = challenge()
        val (keyId, chain) = withContext(Dispatchers.IO) {
            val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setAttestationChallenge(sha256(challenge.toByteArray(Charsets.UTF_8)))
                .build()
            val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE).run {
                initialize(spec)
                generateKeyPair()
            }
            base64(sha256(pair.public.encoded)) to keyStore().getCertificateChain(alias).map { base64(it.encoded) }
        }
        post("/attest/android", buildJsonObject {
            put("keyId", keyId)
            putJsonArray("certificateChain") { chain.forEach { add(it) } }
            put("challenge", challenge)
        }).close()
        prefs.edit().putString(KEY_ID, keyId).apply()
        return keyId
    }

    /** A one-time challenge from the server. */
    private suspend fun challenge(): String {
        val text = send(Request.Builder().url("$baseUrl/attest/challenge").get()).use { it.body!!.string() }
        return SyncJson.parseToJsonElement(text).jsonObject.getValue("challenge").jsonPrimitive.content
    }

    private fun storedToken(): String? = prefs.getString(TOKEN, null)

    // Plumbing

    private suspend fun post(path: String, body: JsonObject, headers: Map<String, String> = emptyMap()): Response {
        val request = Request.Builder().url(baseUrl + path).post(body.toString().toRequestBody(JSON))
        headers.forEach { (field, value) -> request.header(field, value) }
        return send(request)
    }

    /** The response, which the caller closes, or a [SpaceServerException]. */
    private suspend fun send(request: Request.Builder): Response = withContext(Dispatchers.IO) {
        val response = http.newCall(request.header("Accept", "application/json").build()).execute()
        if (!response.isSuccessful) {
            val text = response.use { it.body?.string().orEmpty() }
            val error = runCatching { SyncJson.parseToJsonElement(text).jsonObject }.getOrNull()
            throw SpaceServerException(
                response.code,
                error?.get("code")?.jsonPrimitive?.contentOrNull ?: "UNKNOWN",
                error?.get("message")?.jsonPrimitive?.contentOrNull,
            )
        }
        response
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        const val KEYSTORE = "AndroidKeyStore"
        const val TOKEN = "token"
        const val KEY_ID = "keyId"
        const val COUNTER = "counter"

        fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

        fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

        fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    }
}
