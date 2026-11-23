import type {
  AddAgentDraft,
  Agent,
  Channel,
  ClearedItem,
  Computer,
  HarnessInfo,
  PermissionMode,
  Person,
  SlashCommand,
  WaitingItem,
  Workspace,
} from './types';

export const WORKSPACES: readonly Workspace[] = [
  { id: 'northwind', name: 'Northwind', initial: 'N', active: true },
  { id: 'ridge', name: 'Ridge', initial: 'R', active: false },
];

export const CURRENT_USER_ID = 'maya';

export const PEOPLE: readonly Person[] = [
  {
    id: 'maya',
    name: 'Maya Keller',
    initials: 'MK',
    tone: 'maya',
    presence: 'online',
  },
  {
    id: 'jonas',
    name: 'Jonas Brandt',
    initials: 'JB',
    tone: 'jonas',
    presence: 'away',
  },
];

export const COMPUTERS: readonly Computer[] = [
  {
    id: 'studio-mac-mini',
    name: 'Studio · Mac mini',
    shortName: 'Studio Mac mini',
    online: true,
  },
  {
    id: 'mayas-macbook',
    name: "Maya's MacBook",
    shortName: "Maya's MacBook",
    online: true,
  },
];

export const HARNESSES: readonly HarnessInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    tag: 'claude',
    status: 'Signed in',
    installed: true,
  },
  {
    id: 'codex',
    name: 'Codex',
    tag: 'codex',
    status: 'Signed in',
    installed: true,
  },
  {
    id: 'agy',
    name: 'Antigravity',
    tag: 'agy',
    status: 'Signed in',
    installed: true,
  },
  {
    id: 'grok',
    name: 'Grok',
    tag: 'grok',
    status: 'Not installed',
    installed: false,
  },
];

export const MODEL_OPTIONS: readonly string[] = [
  'Opus 5.5 · High',
  'Sonnet 5.5 · Medium',
  'GPT-6.1 · High',
  'Gemini 4 · High',
];

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'Ask before edits',
  'Edit files, ask for commands',
  'Work on its own',
];

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { command: '/ask', description: 'a question with buttons' },
  { command: '/todo', description: 'assign work' },
  { command: '/review', description: 'request a review' },
  {
    command: '/compact',
    description: 'shrink the context',
    scopeBadge: 'Atlas',
  },
];

export const DEFAULT_ADD_AGENT_DRAFT: AddAgentDraft = {
  computerId: 'studio-mac-mini',
  harnessId: 'claude',
  name: 'Docs Writer',
  folder: '~/northwind/docs',
  mode: 'Ask before edits',
};

export const INITIAL_EXPANDED_STEPS: Record<string, boolean> = {
  'step-atlas-3': true,
};

export function createInitialAgents(): Agent[] {
  return [
    {
      id: 'atlas',
      name: 'Atlas',
      initial: 'A',
      tone: 'purple',
      computerId: 'studio-mac-mini',
      harnessId: 'claude',
      folder: '~/northwind/api',
      state: 'waiting',
      stateElapsed: '12s',
      sidebarStateLabel: 'Waiting on you',
      channelActivity: 'Waiting on you · push',
      model: 'Opus 5.5 · High',
      mode: 'Ask before edits',
      sessionMeta: {
        branch: 'fix/discount-before-tax',
        contextUsedPercent: 38,
        totalAdded: 14,
        totalRemoved: 3,
        files: [
          { path: 'checkout/totals.ts', added: 9, removed: 3 },
          { path: 'checkout/totals.test.ts', added: 5, removed: 0 },
        ],
        watcherIds: ['maya', 'jonas'],
      },
      events: [
        {
          id: 'evt-atlas-1',
          type: 'person_message',
          authorId: 'maya',
          timestamp: '10:42',
          text: "Checkout fails for carts with a discount code since yesterday's release. Find it, fix it, and open a pull request.",
          phoneText:
            'Checkout fails for carts with a discount code. Find it, fix it, open a pull request.',
        },
        {
          id: 'evt-atlas-2',
          type: 'agent_steps',
          agentId: 'atlas',
          durationLabel: 'Worked for 1m 52s',
          steps: [
            {
              id: 'step-atlas-1',
              kind: 'Read',
              target: 'api/checkout/totals.ts',
              state: 'ok',
              showOnPhone: false,
            },
            {
              id: 'step-atlas-2',
              kind: 'Search',
              target: 'applyDiscount',
              result: { kind: 'info', text: '6 matches' },
              state: 'ok',
              showOnPhone: false,
            },
            {
              id: 'step-atlas-3',
              kind: 'Ran',
              target: 'npm test -- checkout',
              result: { kind: 'error', text: '2 failed' },
              state: 'error',
              showOnPhone: true,
              output: {
                headlineParts: [
                  { text: 'expected total ' },
                  { text: '86.40', tone: 'added' },
                  { text: ', received ' },
                  { text: '88.00', tone: 'removed' },
                ],
                detail: 'at totals.test.ts:41 · discount applied after tax',
              },
            },
            {
              id: 'step-atlas-4',
              kind: 'Edited',
              target: 'api/checkout/totals.ts',
              phoneTarget: 'checkout/totals.ts',
              result: { kind: 'diff', added: 9, removed: 3 },
              state: 'ok',
              showOnPhone: true,
            },
            {
              id: 'step-atlas-5',
              kind: 'Ran',
              target: 'npm test -- checkout',
              result: { kind: 'success', text: '41 passed' },
              state: 'ok',
              showOnPhone: true,
            },
          ],
        },
        {
          id: 'evt-atlas-3',
          type: 'agent_text',
          agentId: 'atlas',
          text: 'The discount was applied after tax, so totals for discounted carts stopped matching the payment. I moved it before tax and added a test for a 20% code. The branch is ready.',
          phoneText:
            'The discount was applied after tax. I moved it before tax and added a test. The branch is ready.',
        },
        {
          id: 'evt-atlas-4',
          type: 'approval_request',
          agentId: 'atlas',
          approvalId: 'wait-atlas-push',
          title: 'Atlas wants to push to GitHub',
          command: 'git push origin fix/discount-before-tax',
          options: [
            { id: 'allow-once', label: 'Allow once', primary: true },
            {
              id: 'always-folder',
              label: 'Always allow in this folder',
              phoneLabel: 'Always here',
            },
            { id: 'deny', label: 'Deny' },
          ],
        },
        {
          id: 'evt-atlas-5',
          type: 'queued_message',
          authorName: 'Jonas',
          text: 'Also check the refund path.',
        },
      ],
    },
    {
      id: 'juno',
      name: 'Juno',
      initial: 'J',
      tone: 'green',
      computerId: 'studio-mac-mini',
      harnessId: 'codex',
      folder: '~/northwind/web',
      state: 'working',
      stateElapsed: '2m',
      sidebarStateLabel: 'Working · 2m',
      channelActivity: 'Working · release notes',
      model: 'GPT-6.1 · High',
      mode: 'Edit files, ask for commands',
      sessionMeta: {
        branch: 'release/2.4.1',
        contextUsedPercent: 24,
        totalAdded: 32,
        totalRemoved: 4,
        files: [{ path: 'CHANGELOG.md', added: 32, removed: 4 }],
        watcherIds: ['maya'],
      },
      events: [
        {
          id: 'evt-juno-1',
          type: 'person_message',
          authorId: 'maya',
          timestamp: '10:31',
          text: 'Draft the release notes once the discount fix merges.',
        },
        {
          id: 'evt-juno-2',
          type: 'agent_steps',
          agentId: 'juno',
          durationLabel: 'Working · 2m 04s',
          steps: [
            {
              id: 'step-juno-1',
              kind: 'Read',
              target: 'CHANGELOG.md',
              state: 'ok',
              showOnPhone: true,
            },
            {
              id: 'step-juno-2',
              kind: 'Search',
              target: 'discount',
              result: { kind: 'info', text: '3 commits' },
              state: 'ok',
              showOnPhone: true,
            },
          ],
        },
        {
          id: 'evt-juno-3',
          type: 'agent_text',
          agentId: 'juno',
          text: 'Reading CHANGELOG.md and collecting merged pull requests since 2.4.0.',
        },
      ],
    },
    {
      id: 'reviewer',
      name: 'Reviewer',
      initial: 'R',
      tone: 'blue',
      computerId: 'studio-mac-mini',
      harnessId: 'claude',
      folder: '~/northwind/api',
      state: 'idle',
      stateElapsed: '18m',
      sidebarStateLabel: 'Idle · 18m',
      channelActivity: 'Reading #482',
      model: 'Opus 5.5 · High',
      mode: 'Ask before edits',
      sessionMeta: {
        branch: 'main',
        contextUsedPercent: 19,
        totalAdded: 0,
        totalRemoved: 0,
        files: [],
        watcherIds: ['maya'],
      },
      events: [
        {
          id: 'evt-reviewer-1',
          type: 'agent_steps',
          agentId: 'reviewer',
          durationLabel: 'Worked for 48s',
          steps: [
            {
              id: 'step-reviewer-1',
              kind: 'Read',
              target: 'api/checkout/totals.ts',
              state: 'ok',
              showOnPhone: true,
            },
          ],
        },
        {
          id: 'evt-reviewer-2',
          type: 'agent_text',
          agentId: 'reviewer',
          text: 'Reviewed northwind/api #482. Discount order matches Stripe invoice calculation; checking refund totals next.',
        },
      ],
    },
    {
      id: 'scout',
      name: 'Scout',
      initial: 'S',
      tone: 'amber',
      computerId: 'mayas-macbook',
      harnessId: 'agy',
      folder: '~/northwind/docs',
      state: 'working',
      stateElapsed: '14s',
      sidebarStateLabel: 'Working · 14s',
      channelActivity: 'Indexing docs',
      model: 'Gemini 4 · High',
      mode: 'Work on its own',
      sessionMeta: {
        branch: 'docs/checkout-discounts',
        contextUsedPercent: 14,
        totalAdded: 18,
        totalRemoved: 2,
        files: [{ path: 'docs/checkout.md', added: 18, removed: 2 }],
        watcherIds: ['maya'],
      },
      events: [
        {
          id: 'evt-scout-1',
          type: 'agent_steps',
          agentId: 'scout',
          durationLabel: 'Working · 14s',
          steps: [
            {
              id: 'step-scout-1',
              kind: 'Search',
              target: 'tax calculation',
              result: { kind: 'info', text: '4 pages' },
              state: 'ok',
              showOnPhone: true,
            },
          ],
        },
        {
          id: 'evt-scout-2',
          type: 'agent_text',
          agentId: 'scout',
          text: 'Updating checkout pricing examples to show discounts applied before tax.',
        },
      ],
    },
  ];
}

export function createInitialChannels(): Channel[] {
  return [
    {
      name: 'general',
      unread: false,
      peopleCount: 2,
      agentIds: ['atlas', 'juno'],
      messages: [
        {
          id: 'msg-general-1',
          authorType: 'person',
          authorId: 'jonas',
          timestamp: '09:15',
          segments: [
            {
              type: 'text',
              value: 'Morning. Checkout release cut is planned for noon.',
            },
          ],
        },
      ],
    },
    {
      name: 'launch',
      unread: true,
      peopleCount: 2,
      agentIds: ['atlas', 'juno', 'reviewer'],
      messages: [
        {
          id: 'msg-launch-1',
          authorType: 'person',
          authorId: 'maya',
          timestamp: '10:31',
          segments: [
            {
              type: 'mention',
              agentId: 'atlas',
              label: '@Atlas',
              tone: 'purple',
            },
            { type: 'text', value: ' fix the discount bug. ' },
            {
              type: 'mention',
              agentId: 'juno',
              label: '@Juno',
              tone: 'green',
            },
            {
              type: 'text',
              value: ' draft the release notes once it merges.',
            },
          ],
        },
        {
          id: 'msg-launch-2',
          authorType: 'agent',
          authorId: 'juno',
          timestamp: '10:33',
          workingCard: {
            statusLabel: 'Working',
            activity: 'Reading CHANGELOG.md',
            meta: '7 steps · 2m 04s',
          },
        },
        {
          id: 'msg-launch-3',
          authorType: 'agent',
          authorId: 'atlas',
          timestamp: '10:44',
          segments: [
            { type: 'text', value: 'Fixed on ' },
            { type: 'code', value: 'fix/discount-before-tax' },
            {
              type: 'text',
              value:
                '. The discount is now applied before tax. I need approval to push.',
            },
          ],
          reviewCard: {
            title: 'Review · northwind/api #482',
            commit: 'a41c9e2',
            chips: [
              { label: 'Tests passed', tone: 'working' },
              { label: 'Reviewer · reading', tone: 'neutral' },
              { label: 'Maya · your turn', tone: 'needs-you' },
            ],
          },
        },
        {
          id: 'msg-launch-4',
          authorType: 'person',
          authorId: 'jonas',
          timestamp: '10:46',
          segments: [
            {
              type: 'text',
              value:
                'Nice. Refunds use the same totals code, worth a look before we ship.',
            },
          ],
        },
      ],
    },
    {
      name: 'design',
      unread: false,
      peopleCount: 2,
      agentIds: ['scout'],
      messages: [
        {
          id: 'msg-design-1',
          authorType: 'person',
          authorId: 'maya',
          timestamp: '09:50',
          segments: [
            {
              type: 'text',
              value: 'Sharing the updated dark-mode tokens for review.',
            },
          ],
        },
      ],
    },
    {
      name: 'support',
      unread: false,
      peopleCount: 2,
      agentIds: ['atlas'],
      messages: [
        {
          id: 'msg-support-1',
          authorType: 'person',
          authorId: 'jonas',
          timestamp: '10:12',
          segments: [
            {
              type: 'text',
              value:
                'Two customers reported discount totals mismatching Stripe receipts.',
            },
          ],
        },
      ],
    },
  ];
}

export function createInitialWaitingItems(): WaitingItem[] {
  return [
    {
      id: 'wait-atlas-push',
      kind: 'approval',
      agentId: 'atlas',
      title: 'Atlas wants to push to GitHub',
      meta: '# launch · 12s',
      command: 'git push origin fix/discount-before-tax',
      options: [
        { id: 'allow-once', label: 'Allow once', primary: true },
        {
          id: 'always-folder',
          label: 'Always allow in this folder',
          phoneLabel: 'Always here',
        },
        { id: 'deny', label: 'Deny' },
      ],
      status: 'open',
    },
    {
      id: 'wait-juno-version',
      kind: 'choice',
      agentId: 'juno',
      title: 'Which version number for this release?',
      meta: 'Juno · 4m',
      options: [
        { id: '2.4.1', label: '2.4.1 · patch', recommended: true },
        { id: '2.5.0', label: '2.5.0 · minor' },
        { id: 'other', label: 'Something else' },
      ],
      status: 'open',
    },
    {
      id: 'wait-reviewer-pr482',
      kind: 'review',
      agentId: 'reviewer',
      title: 'Review northwind/api #482',
      meta: 'Reviewer · 9m',
      targetRoute: '/channels/launch',
      status: 'open',
    },
    {
      id: 'wait-docs-logo',
      kind: 'choice',
      agentId: 'scout',
      title: 'Pick a logo for the docs site',
      meta: 'Scout · 22m',
      options: [
        { id: 'wordmark', label: 'Wordmark', recommended: true },
        { id: 'monogram', label: 'Monogram' },
      ],
      status: 'dismissed',
    },
  ];
}

export function createInitialClearedItems(): ClearedItem[] {
  return [
    {
      id: 'cleared-1',
      title: 'Approve the staging deploy',
      reason: 'Answered by Jonas',
    },
    {
      id: 'cleared-2',
      title: 'Which database for the demo?',
      reason: 'Replaced by a newer question',
    },
    {
      id: 'cleared-3',
      title: 'Review northwind/web #77',
      reason: 'Pull request merged',
    },
  ];
}
