import { WebexFake } from './webexFake';

/** The Webex fake as a service (Compose profile `webex`); people and rooms are created through /_test. */
const port = Number(process.env.PORT ?? 8099);
const fake = await new WebexFake().listen(port, '0.0.0.0');
console.log(`webex fake listening on :${port} (API under /v1, control under /_test)`);
process.on('SIGTERM', () => void fake.close().then(() => process.exit(0)));
