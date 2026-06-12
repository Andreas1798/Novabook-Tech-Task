import { createApp } from "./app.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen(port, () => {
  logger.info({ port }, "tax service listening");
});
