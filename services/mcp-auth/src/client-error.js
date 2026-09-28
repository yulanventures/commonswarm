const RESPONSES = new Map([
  [400, "invalid_request"],
  [413, "request_too_large"],
]);

export class ClientError extends Error {
  constructor(status) {
    const code = RESPONSES.get(status);
    if (!code) throw new TypeError("unsupported client error status");
    super(code);
    this.name = "ClientError";
    Object.defineProperties(this, {
      status: { enumerable: true, value: status },
      code: { enumerable: true, value: code },
    });
  }
}
