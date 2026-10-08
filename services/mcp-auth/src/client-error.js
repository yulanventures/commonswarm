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

const INTERACTION_RESPONSES = new Map([
  ["invalid_callback", 400],
  ["different_account", 409],
  ["interaction_binding_mismatch", 409],
  ["interaction_mismatch", 409],
  ["interaction_expired", 410],
]);

export class InteractionStateError extends Error {
  constructor(code, message = code, options) {
    const status = INTERACTION_RESPONSES.get(code);
    if (!status) throw new TypeError("unsupported interaction state error");
    super(message, options);
    this.name = "InteractionStateError";
    Object.defineProperties(this, {
      status: { enumerable: true, value: status },
      code: { enumerable: true, value: code },
    });
  }
}
