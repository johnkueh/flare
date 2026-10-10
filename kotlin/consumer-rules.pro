# UniFFI's bindings reach the library through JNA, which reflects on these.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-keep class com.johnkueh.sync.ffi.** { *; }
-dontwarn java.awt.**
