import Fastify from 'fastify';
/** Public tunnel boundary: never forward the dashboard, administration or call origination API. */
export function createWebhookGateway(target: string) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
    done(null, body),
  );
  app.post('/webhooks/elevenlabs/post-call', async (request, reply) => {
    try {
      const response = await fetch(`${target}/webhooks/elevenlabs/post-call`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'elevenlabs-signature': String(request.headers['elevenlabs-signature'] ?? ''),
        },
        body: request.body as string,
        signal: AbortSignal.timeout(25_000),
      });
      return reply
        .code(response.status)
        .type('application/json')
        .send(await response.text());
    } catch {
      return reply.code(503).send({ error: 'local_receiver_unavailable' });
    }
  });
  return app;
}
