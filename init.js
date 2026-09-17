export default {
  async fetch(request, env, ctx) {
    return new Response("Hello! Your nomasmusic worker is live!", {
      headers: { "content-type": "text/plain" },
    });
  },
};