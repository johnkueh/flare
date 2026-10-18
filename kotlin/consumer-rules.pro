# UniFFI's bindings reach the library through JNA, which reflects on these.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class com.johnkueh.sync.ffi.** { *; }
-dontwarn java.awt.**
# FlarePushMessagingService compiles against Firebase Messaging, which only
# apps with push include.
-dontwarn com.google.firebase.messaging.**
-dontwarn com.google.android.gms.tasks.**
# FlareLinks compiles against the Play Install Referrer library, which only
# apps with deferred links include.
-dontwarn com.android.installreferrer.**
