// The Worker the tests call: auth under /v1/auth, plus two routes that show
// what an app's own routes see.
import { authenticate, type FlareAuthEnv, flareAuth, whoIs } from "../src/index";

export default {
  async fetch(request, env) {
    const auth = flareAuth(env, {
      onLinkAccount: async ({ anonymousUserId, userId }) => {
        await env.DB.prepare("INSERT INTO test_links (anonymous_user_id, user_id) VALUES (?, ?)")
          .bind(anonymousUserId, userId)
          .run();
      },
      // Email and password stands in for Apple and email codes, which need
      // outside services, as "a real account".
      betterAuth: { emailAndPassword: { enabled: true } },
    });
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/v1/auth/")) return auth.handler(request);
    if (pathname === "/v1/whoami") return Response.json(await whoIs(auth, request.headers));
    if (pathname === "/v1/space-check") {
      const user = await authenticate(auth, request);
      return user instanceof Response ? user : Response.json({ user });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<FlareAuthEnv>;
