/**
 * Cleans an error message that Grafana's Prometheus backend produced from an upstream error.
 *
 * Grafana formats Prometheus API errors as `<errorType>: <error>`. Upstreams that omit
 * `errorType` (some Thanos and proxy deployments) yield `: parse error: ...`.
 */
export function cleanPrometheusError(message: string): string {
  return message.replace(/^\s*:\s+/, '').trim();
}

const NON_JSON = /response from prometheus couldn't be parsed\. it is non-json:\s*([\s\S]*)$/i;
// json-iterator reports `..., error found in #N byte of ...|PARSED|..., bigger context ...|CONTEXT|...`.
const BIGGER_CONTEXT = /bigger context \.\.\.\|([\s\S]*?)\|\.\.\.\s*$/;
const PARSED_CONTEXT = /error found in #\d+ byte of \.\.\.\|([\s\S]*?)\|\.\.\./;
const LIMIT_ERROR =
  /time range|exceed(?:s|ed)? (?:the )?(?:limit|max)|too (?:many (?:series|samples|points)|large)|(?:series|samples?|chunks?) limit|limit (?:of|exceeded)|max(?:imum)? (?:series|samples|points|resolution)|\b422\b|unprocessable/i;

/**
 * Describes a Prometheus error for the assistant: drops Grafana's empty error type, shows the
 * upstream text that Grafana could not parse as JSON (plain-text 400s from Thanos or proxies),
 * and adds a hint when the upstream rejected the request for its range or size.
 */
export function describePrometheusError(message: string): string {
  let text = cleanPrometheusError(message);
  const nonJson = NON_JSON.exec(text);
  if (nonJson) {
    const decoderError = nonJson[1];
    const upstream = (BIGGER_CONTEXT.exec(decoderError)?.[1] ?? PARSED_CONTEXT.exec(decoderError)?.[1] ?? '').trim();
    const prefix = text.slice(0, nonJson.index);
    text = upstream
      ? `${prefix}Prometheus answered with a non-JSON error: ${JSON.stringify(upstream)} (may be cut off)`
      : `${prefix}Prometheus answered with a response that is not JSON (${decoderError.trim()})`;
  }
  if (LIMIT_ERROR.test(text) && !/hint:/.test(text)) {
    text +=
      '; hint: the upstream limits the request size: shorten the time range (--from/--to, or --since for discovery), use a coarser --step for range queries, or narrow the selector';
  }
  return text;
}
