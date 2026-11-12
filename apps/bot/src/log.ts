const ts = () => new Date().toISOString();
const fmt = (err: unknown) => (err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err === undefined ? "" : String(err));

export const log = {
  info: (msg: string) => console.log(`${ts()} INFO  ${msg}`),
  warn: (msg: string, err?: unknown) => console.warn(`${ts()} WARN  ${msg} ${fmt(err)}`),
  error: (msg: string, err?: unknown) => console.error(`${ts()} ERROR ${msg} ${fmt(err)}`),
};
