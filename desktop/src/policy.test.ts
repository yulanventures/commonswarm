import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_ORIGIN,
  APP_URL,
  buildContextMenuDescriptor,
  canExecuteContextMenuLinkAction,
  classifyNavigation,
  clearLinkTicketOnActivationWithoutLink,
  consumeTicketAfterAttempt,
  CONTEXT_MENU_COPY_LINK_LABEL,
  CONTEXT_MENU_OPEN_LINK_LABEL,
  getAllowedDevOrigin,
  INITIAL_LINK_TICKET_STATE,
  isAllowedExternalUrl,
  isAllowedSignInUrl,
  isAppOriginUrl,
  isPermissionAllowed,
  isSameDocumentIdentity,
  isTicketValidForDestination,
  LINK_TICKET_WINDOW_MS,
  MAX_ACTIVATION_FUTURE_SKEW_MS,
  MAX_EXTERNAL_URL_LENGTH,
  normalizeTicketUrl,
  OVERRIDE_ENV_VAR,
  recordLinkActivation,
  resolveAppUrl,
  retireLinkTicketOnDocumentChange,
  SIGN_IN_HOSTS,
  validateActivationTimestamp,
  type DocumentIdentity,
  type LinkActivationTicket,
} from "./policy.js";

const DOC_1: DocumentIdentity = Object.freeze({
  frameTreeNodeId: 10,
  processId: 4,
  routingId: 2,
  frameToken: "frame-token-1",
  origin: APP_ORIGIN,
  documentGeneration: 1,
});

const DOC_1_RELOADED: DocumentIdentity = Object.freeze({
  ...DOC_1,
  documentGeneration: 2,
});

const NOW = 10_000;

function makeTicket(
  url: string,
  overrides: Partial<LinkActivationTicket> = {},
): LinkActivationTicket {
  const normalized = normalizeTicketUrl(url);
  assert.ok(normalized, `expected test ticket URL to normalize: ${url}`);
  return {
    url: normalized,
    document: DOC_1,
    activatedAt: NOW - 50,
    ...overrides,
  };
}

const APP_NAV_NO_TICKET = {
  source: "navigate",
  isMainFrame: true,
  initiatorIsMainFrame: true,
  initiatorOrigin: APP_ORIGIN,
  initiatorUrl: APP_URL,
  currentDocument: DOC_1,
  now: NOW,
} as const;

const APP_NEW_WINDOW_NO_TICKET = {
  source: "new_window",
  isMainFrame: true,
  initiatorIsMainFrame: true,
  initiatorOrigin: APP_ORIGIN,
  initiatorUrl: APP_URL,
  currentDocument: DOC_1,
  now: NOW,
  mainFrameHasSubframes: false,
} as const;

function appNavWithTicket(url: string, overrides: Partial<LinkActivationTicket> = {}) {
  return {
    ...APP_NAV_NO_TICKET,
    linkTicket: makeTicket(url, overrides),
  };
}

function appNewWindowWithTicket(url: string, overrides: Partial<LinkActivationTicket> = {}) {
  return {
    ...APP_NEW_WINDOW_NO_TICKET,
    linkTicket: makeTicket(url, overrides),
  };
}

test("classifyNavigation allows the CommonSwarm app origin on any path from app main frame", () => {
  for (const url of [
    "https://commonswarm.com",
    "https://commonswarm.com/app",
    "https://commonswarm.com/invite?token=abc#section",
    "https://commonswarm.com/support",
  ]) {
    assert.equal(classifyNavigation(url, APP_NAV_NO_TICKET), "in_app");
    assert.equal(classifyNavigation(url, appNavWithTicket(url)), "in_app");
    assert.equal(classifyNavigation(url, APP_NEW_WINDOW_NO_TICKET), "in_app");
    assert.equal(classifyNavigation(url, appNewWindowWithTicket(url)), "in_app");
  }
});

test("classifyNavigation ignores subframe navigations and redirects and blocks subframe new_window", () => {
  const ticket = makeTicket("https://foreign.example/frame");
  for (const url of [
    "https://foreign.example/frame",
    "https://commonswarm.com/app",
    "https://api.commonswarm.com/auth/v1/authorize?provider=github",
    "http://127.0.0.1:9999/subframe",
    "javascript:alert(1)",
  ]) {
    assert.equal(
      classifyNavigation(url, {
        source: "navigate",
        isMainFrame: false,
        initiatorIsMainFrame: false,
        initiatorOrigin: "https://foreign.example",
        linkTicket: ticket,
        currentDocument: DOC_1,
        now: NOW,
      }),
      "ignore",
      `expected subframe navigate to ${url} to be ignored`,
    );
    assert.equal(
      classifyNavigation(url, {
        source: "redirect",
        isMainFrame: false,
        continuingTrustedNavigation: true,
        previousNavigationUrl: APP_URL,
        linkTicket: ticket,
        currentDocument: DOC_1,
        now: NOW,
      }),
      "ignore",
      `expected subframe redirect to ${url} to be ignored`,
    );
    assert.equal(
      classifyNavigation(url, {
        source: "new_window",
        isMainFrame: false,
        initiatorIsMainFrame: false,
        initiatorOrigin: "https://foreign.example",
        linkTicket: ticket,
        currentDocument: DOC_1,
        now: NOW,
      }),
      "blocked",
      `expected subframe new_window to ${url} to be blocked`,
    );
  }
});

test("classifyNavigation cancels main-frame navigations started by non-app or non-main-frame initiators", () => {
  const untrustedInitiators = [
    {
      label: "subframe at foreign origin",
      initiatorIsMainFrame: false,
      initiatorOrigin: "https://foreign.example",
      initiatorUrl: "https://foreign.example/embed",
    },
    {
      label: "subframe even at app origin",
      initiatorIsMainFrame: false,
      initiatorOrigin: APP_ORIGIN,
      initiatorUrl: APP_URL,
    },
    {
      label: "missing initiator",
      initiatorIsMainFrame: false,
      initiatorOrigin: null,
      initiatorUrl: null,
    },
    {
      label: "foreign main frame",
      initiatorIsMainFrame: true,
      initiatorOrigin: "https://example.com",
      initiatorUrl: "https://example.com/page",
    },
    {
      label: "opaque origin",
      initiatorIsMainFrame: true,
      initiatorOrigin: "null",
      initiatorUrl: "about:blank",
    },
    {
      label: "unlisted path on sign-in host",
      initiatorIsMainFrame: true,
      initiatorOrigin: "https://github.com",
      initiatorUrl: "https://github.com/yulanventures/commonswarm",
    },
    {
      label: "mismatched initiatorOrigin and initiatorUrl",
      initiatorIsMainFrame: true,
      initiatorOrigin: APP_ORIGIN,
      initiatorUrl: "https://evil.example/spoof",
    },
  ];

  for (const init of untrustedInitiators) {
    for (const target of [
      "https://commonswarm.com/app",
      "https://api.commonswarm.com/auth/v1/authorize?provider=github",
      "https://github.com/login/oauth/authorize?client_id=abc",
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc",
      "https://example.com/external",
    ]) {
      const ticket = makeTicket(target);
      assert.equal(
        classifyNavigation(target, {
          source: "navigate",
          isMainFrame: true,
          ...init,
          linkTicket: ticket,
          currentDocument: DOC_1,
          now: NOW,
        }),
        "blocked",
        `expected main-frame nav to ${target} from ${init.label} to be blocked`,
      );
      assert.equal(
        classifyNavigation(target, {
          source: "new_window",
          isMainFrame: true,
          ...init,
          linkTicket: ticket,
          currentDocument: DOC_1,
          now: NOW,
          mainFrameHasSubframes: false,
        }),
        "blocked",
        `expected new_window to ${target} from ${init.label} to be blocked`,
      );
    }
  }
});

test("classifyNavigation allows every allow-listed sign-in host path on navigate from app main frame", () => {
  assert.equal(SIGN_IN_HOSTS.length, 3);
  for (const entry of SIGN_IN_HOSTS) {
    assert.ok(entry.reason.length > 0, `missing reason for ${entry.host}`);
    assert.ok(entry.paths.length > 0, `missing paths for ${entry.host}`);
    for (const pathEntry of entry.paths) {
      assert.ok(pathEntry.reason.length > 0, `missing reason for ${entry.host}${pathEntry.prefix}`);
      const samplePath = pathEntry.prefix.endsWith("/")
        ? `${pathEntry.prefix}step`
        : pathEntry.prefix;
      const target = `https://${entry.host}${samplePath}`;
      assert.equal(
        classifyNavigation(target, APP_NAV_NO_TICKET),
        "in_app",
        `expected ${target} to be in_app on navigate from app main frame`,
      );
      assert.equal(
        classifyNavigation(target, appNewWindowWithTicket(target)),
        "external",
        `expected ${target} to be external for new_window with matching ticket`,
      );
      assert.equal(
        classifyNavigation(target, APP_NEW_WINDOW_NO_TICKET),
        "blocked",
        `expected ${target} to be blocked for new_window without ticket`,
      );
    }
    const unlisted = `https://${entry.host}/not-an-auth-path`;
    assert.equal(
      classifyNavigation(unlisted, appNavWithTicket(unlisted)),
      "external",
      `expected unlisted path on ${entry.host} to be external with matching ticket`,
    );
    assert.equal(
      classifyNavigation(unlisted, APP_NAV_NO_TICKET),
      "blocked",
      `expected unlisted path on ${entry.host} to be blocked without ticket`,
    );
  }
});

test("classifyNavigation never opens shell.openExternal on any redirect and cancels unexpected redirects", () => {
  for (const unexpectedTarget of [
    "https://example.com/unexpected",
    "https://github.com/yulanventures/commonswarm/pull/1",
    "https://api.commonswarm.com/functions/v1/command",
    "https://accounts.google.com/ManageAccount",
    "https://commonswarm.com.evil.example/app",
    "https://user:pass@commonswarm.com/app",
    "http://commonswarm.com/app",
    "file:///etc/passwd",
  ]) {
    const ticket = normalizeTicketUrl(unexpectedTarget)
      ? makeTicket(unexpectedTarget)
      : makeTicket("https://example.com/fallback");
    assert.equal(
      classifyNavigation(unexpectedTarget, {
        source: "redirect",
        isMainFrame: true,
        continuingTrustedNavigation: true,
        previousNavigationUrl: "https://api.commonswarm.com/auth/v1/authorize?provider=github",
        linkTicket: ticket,
        currentDocument: DOC_1,
        now: NOW,
      }),
      "blocked",
      `expected redirect to ${unexpectedTarget} to be blocked (never external)`,
    );
  }

  // Redirect without an active trusted main-frame navigation is always blocked
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", {
      source: "redirect",
      isMainFrame: true,
      continuingTrustedNavigation: false,
      previousNavigationUrl: APP_URL,
    }),
    "blocked",
  );
  assert.equal(
    classifyNavigation("https://commonswarm.com/app", {
      source: "redirect",
      isMainFrame: true,
      continuingTrustedNavigation: false,
      previousNavigationUrl: null,
    }),
    "blocked",
  );
  // Redirect reporting a non-main-frame initiator is blocked even if continuingTrustedNavigation is true
  assert.equal(
    classifyNavigation("https://github.com/login/oauth/authorize?client_id=abc", {
      source: "redirect",
      isMainFrame: true,
      initiatorIsMainFrame: false,
      continuingTrustedNavigation: true,
      previousNavigationUrl: APP_URL,
    }),
    "blocked",
  );
});

test("classifyNavigation allows the full OAuth navigate and redirect chain and blocks external escapes from sign-in hosts", () => {
  const steps: ReadonlyArray<{ url: string; source: "navigate" | "redirect" }> = [
    { url: "https://api.commonswarm.com/auth/v1/authorize?provider=github", source: "navigate" },
    { url: "https://github.com/login/oauth/authorize?client_id=abc", source: "redirect" },
    { url: "https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize", source: "redirect" },
    { url: "https://github.com/session", source: "navigate" },
    { url: "https://github.com/sessions/two-factor/app", source: "navigate" },
    { url: "https://api.commonswarm.com/auth/v1/callback?code=123", source: "redirect" },
    { url: "https://commonswarm.com/app?code=123", source: "redirect" },
  ];

  let previousUrl = APP_URL;
  for (const step of steps) {
    const disposition =
      step.source === "redirect"
        ? classifyNavigation(step.url, {
            source: "redirect",
            isMainFrame: true,
            continuingTrustedNavigation: true,
            previousNavigationUrl: previousUrl,
          })
        : classifyNavigation(step.url, {
            source: "navigate",
            isMainFrame: true,
            initiatorIsMainFrame: true,
            initiatorOrigin: new URL(previousUrl).origin,
            initiatorUrl: previousUrl,
          });
    assert.equal(disposition, "in_app", `expected ${step.source} ${previousUrl} -> ${step.url} to be in_app`);
    previousUrl = step.url;
  }

  // While on a sign-in host, arbitrary external links cannot invoke shell.openExternal even with a ticket
  assert.equal(
    classifyNavigation("https://example.com/terms", {
      source: "navigate",
      isMainFrame: true,
      initiatorIsMainFrame: true,
      initiatorOrigin: "https://github.com",
      initiatorUrl: "https://github.com/login",
      linkTicket: makeTicket("https://example.com/terms"),
      currentDocument: DOC_1,
      now: NOW,
    }),
    "blocked",
  );
});

test("link-activation tickets bind external opens to exact normalized URL, fresh window, single use, and document lifetime", () => {
  const targetA = "https://example.com/docs";
  const targetB = "https://example.com/other";

  // 1. External open with no ticket is refused for navigate and new_window
  assert.equal(classifyNavigation(targetA, APP_NAV_NO_TICKET), "blocked");
  assert.equal(classifyNavigation(targetA, APP_NEW_WINDOW_NO_TICKET), "blocked");

  // 2. Ticket for a different URL is refused for navigate and new_window
  assert.equal(classifyNavigation(targetB, appNavWithTicket(targetA)), "blocked");
  assert.equal(classifyNavigation(targetB, appNewWindowWithTicket(targetA)), "blocked");

  // 3. Matching fresh ticket allowed once, then refused after consumption (navigate and new_window)
  for (const source of ["navigate", "new_window"] as const) {
    let state = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: "https://EXAMPLE.COM:443/docs",
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    });
    assert.ok(state.ticket, "expected ticket to be issued");
    assert.equal(state.ticket.url, targetA);
    assert.equal(state.ticket.activatedAt, NOW);

    const opts = {
      source,
      isMainFrame: true,
      initiatorIsMainFrame: true,
      initiatorOrigin: APP_ORIGIN,
      initiatorUrl: APP_URL,
      linkTicket: state.ticket,
      currentDocument: DOC_1,
      now: NOW + 100,
      ...(source === "new_window" ? { mainFrameHasSubframes: false } : {}),
    } as const;

    const first = classifyNavigation(targetA, opts);
    assert.equal(first, "external", `expected matching fresh ticket to allow ${source}`);

    state = consumeTicketAfterAttempt(state, {
      disposition: first,
      rawUrl: targetA,
      source,
      currentDocument: DOC_1,
      now: NOW + 100,
    });
    assert.equal(state.ticket, null, "ticket must be consumed on first decision");

    const second = classifyNavigation(targetA, {
      ...opts,
      linkTicket: state.ticket,
      now: NOW + 110,
    });
    assert.equal(second, "blocked", `expected second ${source} attempt after consumption to be refused`);
  }

  // 4. First mismatched navigation burns the ticket so a subsequent attempt to the original URL is also refused
  let mismatchState = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
    rawUrl: targetA,
    rawActivatedAt: NOW,
    senderMatchesWindow: true,
    senderIsMainFrame: true,
    senderDocument: DOC_1,
    now: NOW,
  });
  const mismatchDisposition = classifyNavigation(targetB, {
    ...APP_NAV_NO_TICKET,
    linkTicket: mismatchState.ticket,
    now: NOW + 20,
  });
  assert.equal(mismatchDisposition, "blocked");
  mismatchState = consumeTicketAfterAttempt(mismatchState, {
    disposition: mismatchDisposition,
    rawUrl: targetB,
    source: "navigate",
    currentDocument: DOC_1,
    now: NOW + 20,
  });
  assert.equal(mismatchState.ticket, null);
  assert.equal(
    classifyNavigation(targetA, {
      ...APP_NAV_NO_TICKET,
      linkTicket: mismatchState.ticket,
      now: NOW + 30,
    }),
    "blocked",
  );

  // 5. Stale ticket (>= 1000ms from click time) or future-dated ticket beyond tolerance is refused
  const freshTicket = makeTicket(targetA, { activatedAt: NOW });
  assert.equal(
    classifyNavigation(targetA, {
      ...APP_NAV_NO_TICKET,
      linkTicket: freshTicket,
      now: NOW + LINK_TICKET_WINDOW_MS - 1,
    }),
    "external",
  );
  assert.equal(
    classifyNavigation(targetA, {
      ...APP_NAV_NO_TICKET,
      linkTicket: freshTicket,
      now: NOW + LINK_TICKET_WINDOW_MS,
    }),
    "blocked",
  );
  assert.equal(
    classifyNavigation(targetA, {
      ...APP_NEW_WINDOW_NO_TICKET,
      linkTicket: freshTicket,
      now: NOW + LINK_TICKET_WINDOW_MS,
    }),
    "blocked",
  );
  assert.equal(
    isTicketValidForDestination(freshTicket, targetA, DOC_1, NOW - MAX_ACTIVATION_FUTURE_SKEW_MS),
    true,
  );
  assert.equal(
    isTicketValidForDestination(freshTicket, targetA, DOC_1, NOW - MAX_ACTIVATION_FUTURE_SKEW_MS - 1),
    false,
  );

  // 6. Ticket from a previous document (same-URL reload or any identity field change) is refused
  const changedDocs: DocumentIdentity[] = [
    DOC_1_RELOADED,
    { ...DOC_1, frameToken: "frame-token-2" },
    { ...DOC_1, routingId: DOC_1.routingId + 1 },
    { ...DOC_1, processId: DOC_1.processId + 1 },
    { ...DOC_1, frameTreeNodeId: DOC_1.frameTreeNodeId + 1 },
    { ...DOC_1, origin: "https://other.example" },
  ];
  for (const nextDoc of changedDocs) {
    assert.equal(isSameDocumentIdentity(DOC_1, nextDoc), false);
    assert.equal(
      classifyNavigation(targetA, {
        ...APP_NAV_NO_TICKET,
        linkTicket: freshTicket,
        currentDocument: nextDoc,
        now: NOW + 10,
      }),
      "blocked",
    );
    assert.equal(
      classifyNavigation(targetA, {
        ...APP_NEW_WINDOW_NO_TICKET,
        linkTicket: freshTicket,
        currentDocument: nextDoc,
        now: NOW + 10,
      }),
      "blocked",
    );
  }

  // Document-change retirement clears any unspent ticket and fences pre-retirement activations
  const retired = retireLinkTicketOnDocumentChange(
    {
      ticket: freshTicket,
      lastRefusal: null,
      retiredAt: null,
    },
    NOW + 25,
  );
  assert.equal(retired.ticket, null);
  assert.equal(retired.retiredAt, NOW + 25);
  assert.equal(
    recordLinkActivation(retired, {
      rawUrl: targetA,
      rawActivatedAt: NOW + 25,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1_RELOADED,
      now: NOW + 30,
    }).ticket,
    null,
  );
  assert.ok(
    recordLinkActivation(retired, {
      rawUrl: targetA,
      rawActivatedAt: NOW + 26,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1_RELOADED,
      now: NOW + 30,
    }).ticket,
  );
});

test("recordLinkActivation rejects invalid URLs, invalid/future/stale timestamps, credentials, oversized URLs, and untrusted senders", () => {
  const invalidUrls: unknown[] = [
    "http://example.com/docs",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "mailto:ops@commonswarm.com",
    "https://user:pass@example.com/docs",
    "https://user@example.com/docs",
    "https://github.com@evil.example/login",
    "",
    "   ",
    "not a url",
    null,
    undefined,
    42,
    { href: "https://example.com" },
    `https://example.com/${"a".repeat(MAX_EXTERNAL_URL_LENGTH)}`,
  ];

  for (const rawUrl of invalidUrls) {
    assert.equal(normalizeTicketUrl(rawUrl), null, `expected normalizeTicketUrl to reject ${String(rawUrl)}`);
    const next = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl,
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    });
    assert.equal(next.ticket, null, `expected no ticket for ${String(rawUrl)}`);
  }

  // Invalid, future, and stale activation timestamps are rejected
  const validUrl = "https://example.com/valid";
  const invalidTimestamps: unknown[] = [
    null,
    undefined,
    "10000",
    NaN,
    Infinity,
    -Infinity,
    -1,
    NOW + 0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NOW + MAX_ACTIVATION_FUTURE_SKEW_MS + 1,
    NOW + 5000,
    NOW - LINK_TICKET_WINDOW_MS,
    NOW - LINK_TICKET_WINDOW_MS - 500,
  ];
  for (const rawActivatedAt of invalidTimestamps) {
    assert.equal(
      validateActivationTimestamp(rawActivatedAt, NOW),
      null,
      `expected validateActivationTimestamp to reject ${String(rawActivatedAt)}`,
    );
    assert.equal(
      recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
        rawUrl: validUrl,
        rawActivatedAt,
        senderMatchesWindow: true,
        senderIsMainFrame: true,
        senderDocument: DOC_1,
        now: NOW,
      }).ticket,
      null,
      `expected no ticket for timestamp ${String(rawActivatedAt)}`,
    );
  }

  // Within future tolerance is accepted
  assert.equal(
    validateActivationTimestamp(NOW + MAX_ACTIVATION_FUTURE_SKEW_MS, NOW),
    NOW + MAX_ACTIVATION_FUTURE_SKEW_MS,
  );

  // Untrusted senders never issue a ticket
  assert.equal(
    recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: validUrl,
      rawActivatedAt: NOW,
      senderMatchesWindow: false,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    null,
  );
  assert.equal(
    recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: validUrl,
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: false,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    null,
  );
  assert.equal(
    recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: validUrl,
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: { ...DOC_1, origin: "https://foreign.example" },
      now: NOW,
    }).ticket,
    null,
  );
  assert.equal(
    recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: validUrl,
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: null,
      now: NOW,
    }).ticket,
    null,
  );

  // activation-without-link validates click time, respects fences, clears for app main frame, and never arms
  const armed = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
    rawUrl: validUrl,
    rawActivatedAt: NOW,
    senderMatchesWindow: true,
    senderIsMainFrame: true,
    senderDocument: DOC_1,
    now: NOW,
  });
  assert.ok(armed.ticket);

  assert.equal(
    clearLinkTicketOnActivationWithoutLink(INITIAL_LINK_TICKET_STATE, {
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    null,
  );
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW,
      senderMatchesWindow: false,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    armed.ticket,
  );
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: false,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    armed.ticket,
  );
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: { ...DOC_1, origin: "https://foreign.example" },
      now: NOW,
    }).ticket,
    armed.ticket,
  );
  // Stale, future, or older-than-ticket non-link activation is ignored
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW - LINK_TICKET_WINDOW_MS,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    armed.ticket,
  );
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW + MAX_ACTIVATION_FUTURE_SKEW_MS + 1,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW,
    }).ticket,
    armed.ticket,
  );
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW - 1,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW + 5,
    }).ticket,
    armed.ticket,
  );
  // Valid fresh non-link activation clears ticket
  assert.equal(
    clearLinkTicketOnActivationWithoutLink(armed, {
      rawActivatedAt: NOW + 5,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW + 10,
    }).ticket,
    null,
  );
});

test("click-time ticket lifetime and refusal fencing reject stale, future, and pre-refusal activations regardless of ticket state", () => {
  const targetA = "https://example.com/link-a";
  const targetB = "https://example.com/link-b";

  // 1. Expiry is click time plus lifetime regardless of arrival time
  const delayedClickAt = NOW;
  const arrivedAt = NOW + 400;
  const delayedState = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
    rawUrl: targetA,
    rawActivatedAt: delayedClickAt,
    senderMatchesWindow: true,
    senderIsMainFrame: true,
    senderDocument: DOC_1,
    now: arrivedAt,
  });
  assert.ok(delayedState.ticket, "delayed click still inside 1000ms lifetime should issue ticket");
  assert.equal(delayedState.ticket.activatedAt, delayedClickAt);
  assert.equal(
    classifyNavigation(targetA, {
      ...APP_NAV_NO_TICKET,
      linkTicket: delayedState.ticket,
      now: delayedClickAt + LINK_TICKET_WINDOW_MS - 1,
    }),
    "external",
    "ticket must remain valid 1ms before clickTime + LINK_TICKET_WINDOW_MS",
  );
  assert.equal(
    classifyNavigation(targetA, {
      ...APP_NAV_NO_TICKET,
      linkTicket: delayedState.ticket,
      now: delayedClickAt + LINK_TICKET_WINDOW_MS,
    }),
    "blocked",
    "ticket must expire at clickTime + LINK_TICKET_WINDOW_MS, not arrivalTime + LINK_TICKET_WINDOW_MS",
  );

  // 2. An activation delayed past the lifetime issues nothing (even with no prior refusal)
  const staleState = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
    rawUrl: targetA,
    rawActivatedAt: NOW,
    senderMatchesWindow: true,
    senderIsMainFrame: true,
    senderDocument: DOC_1,
    now: NOW + LINK_TICKET_WINDOW_MS,
  });
  assert.equal(staleState.ticket, null, "activation delayed to/past lifetime must issue no ticket");
  assert.equal(
    recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: targetA,
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW + LINK_TICKET_WINDOW_MS + 500,
    }).ticket,
    null,
    "activation delayed well past lifetime must issue no ticket",
  );

  // 3. Delayed activation inside lifetime after a refused attempt that saw NO ticket issues nothing (navigate and new_window)
  for (const source of ["navigate", "new_window"] as const) {
    const baseOpts = source === "new_window" ? APP_NEW_WINDOW_NO_TICKET : APP_NAV_NO_TICKET;
    const clickAt = NOW;
    const refusedAt = NOW + 50;

    const refusedDisposition = classifyNavigation(targetA, {
      ...baseOpts,
      linkTicket: null,
      now: refusedAt,
    });
    assert.equal(refusedDisposition, "blocked");

    let state = consumeTicketAfterAttempt(INITIAL_LINK_TICKET_STATE, {
      disposition: refusedDisposition,
      rawUrl: targetA,
      source,
      currentDocument: DOC_1,
      now: refusedAt,
    });
    assert.equal(state.ticket, null);
    assert.equal(state.lastRefusal?.refusedAt, refusedAt);

    // Late activation clicked BEFORE refusal (arrives inside 1s lifetime) issues nothing
    state = recordLinkActivation(state, {
      rawUrl: targetA,
      rawActivatedAt: clickAt,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: refusedAt + 20,
    });
    assert.equal(state.ticket, null, `${source}: pre-refusal activation (no prior ticket) must issue nothing`);

    // Activation at exact refusal millisecond (not strictly AFTER) also issues nothing
    state = recordLinkActivation(state, {
      rawUrl: targetA,
      rawActivatedAt: refusedAt,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: refusedAt + 25,
    });
    assert.equal(state.ticket, null, `${source}: activation equal to refusal time must issue nothing`);

    // A genuinely fresh click AFTER the refusal opens once and is consumed
    const freshClickAt = refusedAt + 1;
    state = recordLinkActivation(state, {
      rawUrl: targetA,
      rawActivatedAt: freshClickAt,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: freshClickAt + 5,
    });
    assert.ok(state.ticket, `${source}: fresh click after refusal must issue a ticket`);
    const freshDisposition = classifyNavigation(targetA, {
      ...baseOpts,
      linkTicket: state.ticket,
      now: freshClickAt + 10,
    });
    assert.equal(freshDisposition, "external", `${source}: fresh click after refusal must open once`);
    state = consumeTicketAfterAttempt(state, {
      disposition: freshDisposition,
      rawUrl: targetA,
      source,
      currentDocument: DOC_1,
      now: freshClickAt + 10,
    });
    assert.equal(state.ticket, null);
    assert.equal(
      classifyNavigation(targetA, {
        ...baseOpts,
        linkTicket: state.ticket,
        now: freshClickAt + 15,
      }),
      "blocked",
      `${source}: second attempt after fresh click is consumed must be blocked`,
    );
  }

  // 4. Delayed activation inside lifetime after a refused attempt that saw a LIVE TICKET for a DIFFERENT URL issues nothing
  for (const source of ["navigate", "new_window"] as const) {
    const baseOpts = source === "new_window" ? APP_NEW_WINDOW_NO_TICKET : APP_NAV_NO_TICKET;

    // Live ticket for A
    let state = recordLinkActivation(INITIAL_LINK_TICKET_STATE, {
      rawUrl: targetA,
      rawActivatedAt: NOW,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: NOW + 5,
    });
    assert.equal(state.ticket?.url, targetA);

    // Click B occurs at NOW + 20, message is delayed in flight
    const clickBAt = NOW + 20;
    const refusedAt = NOW + 40;

    // Attempt B while A's ticket is live -> refused and burns A's ticket AND records refusal
    const refusedDisposition = classifyNavigation(targetB, {
      ...baseOpts,
      linkTicket: state.ticket,
      now: refusedAt,
    });
    assert.equal(refusedDisposition, "blocked");
    state = consumeTicketAfterAttempt(state, {
      disposition: refusedDisposition,
      rawUrl: targetB,
      source,
      currentDocument: DOC_1,
      now: refusedAt,
    });
    assert.equal(state.ticket, null, `${source}: refused attempt for B must burn live ticket for A`);
    assert.equal(state.lastRefusal?.refusedAt, refusedAt);

    // Delayed activation for B arrives inside 1s lifetime -> refused because clickBAt <= refusedAt
    state = recordLinkActivation(state, {
      rawUrl: targetB,
      rawActivatedAt: clickBAt,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: refusedAt + 30,
    });
    assert.equal(state.ticket, null, `${source}: delayed activation for B after refusal with live ticket A must issue nothing`);

    // Attempt B again inside 1s -> blocked
    assert.equal(
      classifyNavigation(targetB, {
        ...baseOpts,
        linkTicket: state.ticket,
        now: refusedAt + 40,
      }),
      "blocked",
    );

    // Fresh click on B AFTER the refusal still opens once
    const freshBAt = refusedAt + 50;
    state = recordLinkActivation(state, {
      rawUrl: targetB,
      rawActivatedAt: freshBAt,
      senderMatchesWindow: true,
      senderIsMainFrame: true,
      senderDocument: DOC_1,
      now: freshBAt + 5,
    });
    assert.ok(state.ticket, `${source}: fresh click on B after refusal must issue a ticket`);
    assert.equal(
      classifyNavigation(targetB, {
        ...baseOpts,
        linkTicket: state.ticket,
        now: freshBAt + 10,
      }),
      "external",
    );
  }
});

test("classifyNavigation blocks new_window when mainFrameHasSubframes is true or omitted, and allows without subframes", () => {
  const targets = [
    "https://example.com/from-frame",
    "https://example.com/docs",
    "https://commonswarm.com/app",
    "https://commonswarm.com/invite",
  ];

  for (const url of targets) {
    assert.equal(
      classifyNavigation(url, {
        ...appNewWindowWithTicket(url),
        mainFrameHasSubframes: true,
      }),
      "blocked",
      `expected new_window to ${url} to be dropped when a subframe is present even with a ticket`,
    );

    const { mainFrameHasSubframes: _omitted, ...withoutSubframeFlag } = appNewWindowWithTicket(url);
    assert.equal(
      classifyNavigation(url, withoutSubframeFlag),
      "blocked",
      `expected new_window to ${url} to fail closed when mainFrameHasSubframes is omitted`,
    );
  }

  assert.equal(
    classifyNavigation("https://example.com/from-frame", {
      ...appNewWindowWithTicket("https://example.com/from-frame"),
      mainFrameHasSubframes: false,
    }),
    "external",
  );
  assert.equal(
    classifyNavigation("https://commonswarm.com/app", {
      ...APP_NEW_WINDOW_NO_TICKET,
      mainFrameHasSubframes: false,
    }),
    "in_app",
  );
  assert.equal(
    classifyNavigation("https://example.com/from-frame", {
      ...APP_NEW_WINDOW_NO_TICKET,
      mainFrameHasSubframes: false,
    }),
    "blocked",
  );
});

test("classifyNavigation blocks non-https, dangerous schemes, credentials, and malformed input even with a ticket", () => {
  const blockedUrls = [
    "http://commonswarm.com",
    "http://commonswarm.com/app",
    "http://api.commonswarm.com/auth/v1/authorize",
    "http://example.com",
    "http://localhost:4321/app",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "commonswarm://open",
    "mailto:ops@commonswarm.com",
    "https://user:pass@commonswarm.com/app",
    "https://user@example.com/docs",
    "https://user:pass@example.com/docs",
    "https://github.com@evil.example/login",
    "",
    "   ",
    "not a url",
    "://missing-scheme",
  ];

  const validTicket = makeTicket("https://example.com/valid");
  for (const url of blockedUrls) {
    assert.equal(
      classifyNavigation(url, { ...APP_NAV_NO_TICKET, linkTicket: validTicket }),
      "blocked",
      `navigate ${url}`,
    );
    assert.equal(
      classifyNavigation(url, { ...APP_NEW_WINDOW_NO_TICKET, linkTicket: validTicket }),
      "blocked",
      `new_window ${url}`,
    );
    assert.equal(
      classifyNavigation(url, {
        source: "redirect",
        isMainFrame: true,
        continuingTrustedNavigation: true,
        previousNavigationUrl: APP_URL,
      }),
      "blocked",
      `redirect ${url}`,
    );
  }
});

test("classifyNavigation allows bundled offline page to retry only the app origin", () => {
  const offlineOpts = {
    source: "navigate",
    isMainFrame: true,
    initiatorIsMainFrame: true,
    initiatorOrigin: "null",
    initiatorUrl: "file:///app/static/offline.html?target=https%3A%2F%2Fcommonswarm.com%2Fapp",
    initiatorIsOfflinePage: true,
    linkTicket: makeTicket("https://example.com/docs"),
    currentDocument: DOC_1,
    now: NOW,
  } as const;

  assert.equal(classifyNavigation("https://commonswarm.com/app", offlineOpts), "in_app");
  assert.equal(classifyNavigation("https://api.commonswarm.com/auth/v1/authorize", offlineOpts), "blocked");
  assert.equal(classifyNavigation("https://example.com/docs", offlineOpts), "blocked");
});

test("buildContextMenuDescriptor returns Open Link in Browser only for an https link in the app main frame", () => {
  const linkUrl = "https://example.com/docs";

  // App main frame + https link -> Open Link in Browser + Copy Link only
  const mainLinkMenu = buildContextMenuDescriptor({
    frameIsAppMainFrame: true,
    frameOrigin: APP_ORIGIN,
    linkUrl,
    isEditable: false,
    hasSelection: false,
  });
  assert.deepEqual(
    mainLinkMenu.map((item) => item.label),
    [CONTEXT_MENU_OPEN_LINK_LABEL, CONTEXT_MENU_COPY_LINK_LABEL],
  );
  assert.equal(mainLinkMenu[0]?.linkUrl, linkUrl);

  // App main frame + https link + selection -> link items, separator, copy
  const withSelection = buildContextMenuDescriptor({
    frameIsAppMainFrame: true,
    frameOrigin: APP_ORIGIN,
    linkUrl,
    isEditable: false,
    hasSelection: true,
  });
  assert.deepEqual(
    withSelection.map((item) => item.id),
    ["open-link", "copy-link", "separator", "copy"],
  );

  // App main frame + editable without link -> standard editing items only, no open-link
  const editableOnly = buildContextMenuDescriptor({
    frameIsAppMainFrame: true,
    frameOrigin: APP_ORIGIN,
    linkUrl: "",
    isEditable: true,
    hasSelection: false,
  });
  assert.ok(!editableOnly.some((item) => item.id === "open-link" || item.id === "copy-link"));
  assert.deepEqual(
    editableOnly.map((item) => item.id),
    ["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"],
  );

  // Subframe, foreign origin, non-https, or credentials -> never includes Open Link in Browser
  const deniedCases = [
    { frameIsAppMainFrame: false, frameOrigin: APP_ORIGIN, linkUrl },
    { frameIsAppMainFrame: false, frameOrigin: "https://foreign.example", linkUrl },
    { frameIsAppMainFrame: true, frameOrigin: "https://foreign.example", linkUrl },
    { frameIsAppMainFrame: true, frameOrigin: "https://github.com", linkUrl },
    { frameIsAppMainFrame: true, frameOrigin: null, linkUrl },
    { frameIsAppMainFrame: true, frameOrigin: APP_ORIGIN, linkUrl: "http://example.com/docs" },
    { frameIsAppMainFrame: true, frameOrigin: APP_ORIGIN, linkUrl: "https://user:pass@example.com/docs" },
    { frameIsAppMainFrame: true, frameOrigin: APP_ORIGIN, linkUrl: "javascript:alert(1)" },
    { frameIsAppMainFrame: true, frameOrigin: APP_ORIGIN, linkUrl: "file:///etc/passwd" },
    { frameIsAppMainFrame: true, frameOrigin: APP_ORIGIN, linkUrl: "" },
  ];
  for (const input of deniedCases) {
    const items = buildContextMenuDescriptor({
      ...input,
      isEditable: false,
      hasSelection: false,
    });
    assert.equal(items.length, 0, `expected empty menu for ${JSON.stringify(input)}`);
  }

  // Re-check at click time: requires exact same document, live app origin, and allowed https URL
  assert.equal(
    canExecuteContextMenuLinkAction({
      capturedDocument: DOC_1,
      currentDocument: DOC_1,
      linkUrl,
    }),
    true,
  );
  assert.equal(
    canExecuteContextMenuLinkAction({
      capturedDocument: DOC_1,
      currentDocument: DOC_1_RELOADED,
      linkUrl,
    }),
    false,
  );
  assert.equal(
    canExecuteContextMenuLinkAction({
      capturedDocument: DOC_1,
      currentDocument: null,
      linkUrl,
    }),
    false,
  );
  assert.equal(
    canExecuteContextMenuLinkAction({
      capturedDocument: DOC_1,
      currentDocument: { ...DOC_1, origin: "https://foreign.example" },
      linkUrl,
    }),
    false,
  );
  assert.equal(
    canExecuteContextMenuLinkAction({
      capturedDocument: DOC_1,
      currentDocument: DOC_1,
      linkUrl: "https://user:pass@example.com/docs",
    }),
    false,
  );
});

test("resolveAppUrl accepts override only when unpackaged and only for allowed origins", () => {
  assert.equal(resolveAppUrl({ isPackaged: false, env: {} }), APP_URL);
  assert.equal(resolveAppUrl({ isPackaged: true, env: {} }), APP_URL);

  // Accepted when unpackaged
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "http://localhost:4321/app" },
    }),
    "http://localhost:4321/app",
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "http://localhost/app" },
    }),
    "http://localhost/app",
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "http://127.0.0.1:4321/app" },
    }),
    "http://127.0.0.1:4321/app",
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: false,
      env: { [OVERRIDE_ENV_VAR]: "https://commonswarm.com/invite" },
    }),
    "https://commonswarm.com/invite",
  );

  // Ignored when packaged, even for allowed origins
  assert.equal(
    resolveAppUrl({
      isPackaged: true,
      env: { [OVERRIDE_ENV_VAR]: "http://localhost:4321/app" },
    }),
    APP_URL,
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: true,
      env: { [OVERRIDE_ENV_VAR]: "http://127.0.0.1:4321/app" },
    }),
    APP_URL,
  );
  assert.equal(
    resolveAppUrl({
      isPackaged: true,
      env: { [OVERRIDE_ENV_VAR]: "https://commonswarm.com/invite" },
    }),
    APP_URL,
  );

  // Rejected origins and malformed values when unpackaged
  for (const rejected of [
    "https://evil.example/app",
    "https://commonswarm.com.evil.example/app",
    "https://commonswarm.com:8443/app",
    "http://commonswarm.com/app",
    "http://127.0.0.2:4321/app",
    "https://localhost:4321/app",
    "file:///tmp/index.html",
    "javascript:alert(1)",
    "http://user:pass@localhost:4321/app",
    "not a url",
  ]) {
    assert.equal(
      resolveAppUrl({
        isPackaged: false,
        env: { [OVERRIDE_ENV_VAR]: rejected },
      }),
      APP_URL,
      `expected override ${rejected} to be rejected`,
    );
  }
});

test("allowedDevOrigin permits only the matching local dev origin in unpackaged mode", () => {
  const devOrigin = getAllowedDevOrigin("http://127.0.0.1:4321/app", false);
  assert.equal(devOrigin, "http://127.0.0.1:4321");
  assert.equal(getAllowedDevOrigin("http://127.0.0.1:4321/app", true), null);
  assert.equal(getAllowedDevOrigin("https://commonswarm.com/app", false), null);

  const devDoc: DocumentIdentity = { ...DOC_1, origin: devOrigin };
  const fromDevMain = {
    source: "navigate",
    isMainFrame: true,
    initiatorIsMainFrame: true,
    initiatorOrigin: devOrigin,
    initiatorUrl: "http://127.0.0.1:4321/app",
    allowedDevOrigin: devOrigin,
    currentDocument: devDoc,
    now: NOW,
  } as const;

  assert.equal(classifyNavigation("http://127.0.0.1:4321/invite", fromDevMain), "in_app");
  assert.equal(
    classifyNavigation("http://127.0.0.1:4321/invite", {
      ...fromDevMain,
      source: "new_window",
      mainFrameHasSubframes: false,
    }),
    "in_app",
  );
  assert.equal(classifyNavigation("http://127.0.0.1:9999/other", fromDevMain), "blocked");
  assert.equal(classifyNavigation("http://commonswarm.com/app", fromDevMain), "blocked");
  assert.equal(
    classifyNavigation("https://api.commonswarm.com/auth/v1/authorize?provider=github", fromDevMain),
    "in_app",
  );
});

test("isPermissionAllowed grants notifications only for app origin in the main frame and fails closed", () => {
  // Missing or empty requester URL: deny
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: undefined, isMainFrame: true }), false);
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: null, isMainFrame: true }), false);
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: "", isMainFrame: true }), false);
  assert.equal(isPermissionAllowed({ permission: "notifications", requestingUrl: "   ", isMainFrame: true }), false);

  // Foreign requester URL: deny (main frame or subframe)
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://evil.example/page", isMainFrame: true }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://evil.example/page", isMainFrame: false }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://github.com/login", isMainFrame: true }),
    false,
  );

  // App origin from subframe: deny
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://commonswarm.com/app", isMainFrame: false }),
    false,
  );

  // App origin with credentials: deny
  assert.equal(
    isPermissionAllowed({
      permission: "notifications",
      requestingUrl: "https://user:pass@commonswarm.com/app",
      isMainFrame: true,
    }),
    false,
  );

  // Non-notification permission from app main frame: deny
  assert.equal(
    isPermissionAllowed({ permission: "geolocation", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "media", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    false,
  );
  assert.equal(
    isPermissionAllowed({ permission: "openExternal", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    false,
  );

  // App origin from main frame: allow
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://commonswarm.com/app", isMainFrame: true }),
    true,
  );
  assert.equal(
    isPermissionAllowed({ permission: "notifications", requestingUrl: "https://commonswarm.com", isMainFrame: true }),
    true,
  );

  // Unpackaged local dev origin: allow matching main frame only, deny other port or subframe
  const devOpts = { allowedDevOrigin: "http://127.0.0.1:4321" };
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:4321/app",
      isMainFrame: true,
    }),
    true,
  );
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:4321/app",
      isMainFrame: false,
    }),
    false,
  );
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:9999/frame",
      isMainFrame: false,
    }),
    false,
  );
  assert.equal(
    isPermissionAllowed({
      ...devOpts,
      permission: "notifications",
      requestingUrl: "http://127.0.0.1:9999/frame",
      isMainFrame: true,
    }),
    false,
  );
});

test("isAppOriginUrl, isAllowedSignInUrl, and isAllowedExternalUrl enforce host and scheme rules", () => {
  assert.equal(isAppOriginUrl("https://commonswarm.com/app"), true);
  assert.equal(isAppOriginUrl("https://github.com/login"), false);
  assert.equal(isAppOriginUrl("https://accounts.google.com/o/oauth2/v2/auth"), false);
  assert.equal(isAppOriginUrl("https://api.commonswarm.com/auth/v1/authorize"), false);

  assert.equal(isAllowedSignInUrl("https://api.commonswarm.com/auth/v1/authorize"), true);
  assert.equal(isAllowedSignInUrl("https://github.com/login"), true);
  assert.equal(isAllowedSignInUrl("https://github.com/yulanventures/commonswarm"), false);

  assert.equal(isAllowedExternalUrl("https://commonswarm.com/support"), true);
  assert.equal(isAllowedExternalUrl("https://example.com"), true);
  assert.equal(isAllowedExternalUrl("https://user:pass@example.com"), false);
  assert.equal(isAllowedExternalUrl("https://user@example.com"), false);
  assert.equal(isAllowedExternalUrl("http://example.com"), false);
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("mailto:ops@commonswarm.com"), false);
  assert.equal(isAllowedExternalUrl("not a url"), false);
});
