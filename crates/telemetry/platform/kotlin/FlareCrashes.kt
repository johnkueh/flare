// Crashes and ANRs for Android apps on Flare telemetry: the platform's own
// sources, no extra dependency. Copy this file into the app, then from
// Application.onCreate:
//
//     val telemetry = TelemetryClient(TelemetryConfig(…))
//     FlareCrashes.start(this, telemetry)
//
// - JVM crashes: an uncaught-exception handler writes a `crash` event to the
//   telemetry queue on disk (it is sent on the next launch), then hands the
//   exception on to the previous handler, so the system still sees it.
// - ANRs and native crashes: read from ApplicationExitInfo (Android 11+) on
//   the next launch, as `hang` and `crash` events. ANRs carry the main
//   thread's stack; native crashes carry only the exit description.
// - Rust panics: the SDK's panic hook.
// Handled errors: `FlareCrashes.reportError(telemetry, e)`.

package flare.telemetry

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import uniffi.telemetry_sdk.ProblemKind
import uniffi.telemetry_sdk.ProblemReport
import uniffi.telemetry_sdk.StackFrame
import uniffi.telemetry_sdk.TelemetryClient

object FlareCrashes {
    private const val PREFS = "flare_crashes"
    private const val LAST_EXIT = "last_exit_ts"
    private val ANR_FRAME = Regex("""^\s+at (\S+)\((.*)\)$""")

    @Volatile private var started = false

    /** Install the handlers and report exits from earlier runs. Safe to call twice. */
    @Synchronized
    fun start(context: Context, client: TelemetryClient, inAppPrefixes: List<String> = listOf(context.packageName)) {
        if (started) return
        started = true
        runCatching { client.installPanicHook() }

        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // report() appends to the queue file before it returns.
            runCatching { client.report(fromThrowable(ProblemKind.CRASH, error, inAppPrefixes)) }
            previous?.uncaughtException(thread, error)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            runCatching { reportExits(context, client, inAppPrefixes) }
        }
    }

    /** Count a caught exception as an `error` event. */
    fun reportError(client: TelemetryClient, error: Throwable, inAppPrefixes: List<String> = emptyList()) {
        runCatching { client.report(fromThrowable(ProblemKind.ERROR, error, inAppPrefixes)) }
    }

    private fun fromThrowable(kind: ProblemKind, error: Throwable, inAppPrefixes: List<String>): ProblemReport {
        // The root cause names the real failure; its stack is the one to group on.
        var root = error
        while (root.cause != null && root.cause !== root) root = root.cause!!
        val frames = root.stackTrace.take(50).map { element ->
            StackFrame(
                module = element.className.substringBeforeLast('.', ""),
                function = "${element.className}.${element.methodName}",
                fileLine = element.fileName?.let { "$it:${element.lineNumber}" },
                inApp = inAppPrefixes.any { element.className.startsWith(it) },
            )
        }
        val message = if (root === error) error.message.orEmpty() else "${error.javaClass.name}: ${root.message.orEmpty()}"
        return ProblemReport(kind = kind, typeName = root.javaClass.name, message = message, frames = frames)
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.R)
    private fun reportExits(context: Context, client: TelemetryClient, inAppPrefixes: List<String>) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = prefs.getLong(LAST_EXIT, 0L)
        val am = context.getSystemService(ActivityManager::class.java) ?: return
        val exits = am.getHistoricalProcessExitReasons(context.packageName, 0, 10).filter { it.timestamp > since }
        // First launch with this code: start counting from now, so exits from
        // before the app had crash reporting aren't reported as new.
        if (since == 0L) {
            prefs.edit().putLong(LAST_EXIT, System.currentTimeMillis()).apply()
            return
        }
        for (exit in exits.sortedBy { it.timestamp }) {
            val report = when (exit.reason) {
                ApplicationExitInfo.REASON_ANR -> ProblemReport(
                    kind = ProblemKind.HANG,
                    typeName = "ANR",
                    message = exit.description.orEmpty(),
                    frames = anrFrames(exit, inAppPrefixes),
                    fromPreviousRun = true,
                    occurredAtMs = exit.timestamp,
                )
                ApplicationExitInfo.REASON_CRASH_NATIVE -> ProblemReport(
                    kind = ProblemKind.CRASH,
                    typeName = "native_crash",
                    message = exit.description.orEmpty(),
                    frames = emptyList(),
                    fromPreviousRun = true,
                    occurredAtMs = exit.timestamp,
                )
                // REASON_CRASH (JVM) is already reported by the handler.
                else -> null
            }
            report?.let { client.report(it) }
        }
        exits.maxOfOrNull { it.timestamp }?.let { prefs.edit().putLong(LAST_EXIT, it).apply() }
        client.flush()
    }

    /** The "main" thread's Java frames from an ANR trace dump. */
    @android.annotation.TargetApi(Build.VERSION_CODES.R)
    private fun anrFrames(exit: ApplicationExitInfo, inAppPrefixes: List<String>): List<StackFrame> {
        val trace = runCatching { exit.traceInputStream?.bufferedReader()?.use { it.readText() } }.getOrNull()
            ?: return emptyList()
        val frames = mutableListOf<StackFrame>()
        var inMain = false
        for (line in trace.lineSequence()) {
            if (line.startsWith("\"main\"")) {
                inMain = true
                continue
            }
            if (!inMain) continue
            if (line.isBlank()) break
            val match = ANR_FRAME.find(line) ?: continue
            val function = match.groupValues[1]
            frames += StackFrame(
                module = function.substringBeforeLast('.', "").substringBeforeLast('.', ""),
                function = function,
                fileLine = match.groupValues[2],
                inApp = inAppPrefixes.any { function.startsWith(it) },
            )
            if (frames.size == 50) break
        }
        return frames
    }
}
