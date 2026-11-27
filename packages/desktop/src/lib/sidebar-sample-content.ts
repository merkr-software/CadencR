import type { FeaturePendingGateResponse } from "@/api/generated";
import { translateUi } from "@/lib/i18n/ui";
import type { RowSummary } from "@/lib/sidebar-row-summary";

/** What the two waiting samples ask: a command to allow, a question to answer. */
export function buildSampleGates(): ReadonlyMap<number, FeaturePendingGateResponse> {
  return new Map([
    [
      -11,
      {
        kind: "permission",
        request_id: "sample-permission",
        session_id: -11,
        last_assistant_text: translateUi(
          "sidebar.samples.checkoutJustification",
          "The checkout test fails about one run in five. I'd like to run it in a loop to catch the race.",
        ),
        payload: {
          tool_name: "Bash",
          tool_input: { command: "pnpm test --filter checkout --repeat 20" },
          options: [
            {
              decision: "allow_once",
              label: translateUi("sidebar.permission.allowOnce", "Allow once"),
            },
            {
              decision: "allow_future",
              label: translateUi("sidebar.permission.alwaysAllow", "Always allow"),
            },
            { decision: "deny", label: translateUi("sidebar.permission.deny", "Deny") },
          ],
        },
      },
    ],
    [
      -31,
      {
        kind: "question",
        request_id: "sample-question",
        session_id: -31,
        payload: {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [
              {
                question: translateUi(
                  "sidebar.samples.spacingQuestion",
                  "Which base unit should the spacing scale use?",
                ),
                header: translateUi("sidebar.samples.spacingHeader", "Spacing"),
                multiSelect: false,
                options: [
                  {
                    label: translateUi("sidebar.samples.spacingOptionSmall", "4 px"),
                    description: translateUi(
                      "sidebar.samples.spacingOptionSmallDescription",
                      "Matches the icon grid",
                    ),
                  },
                  {
                    label: translateUi("sidebar.samples.spacingOptionLarge", "8 px"),
                    description: translateUi(
                      "sidebar.samples.spacingOptionLargeDescription",
                      "Fewer, larger steps",
                    ),
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  ]);
}

/** What the preview's rows show as the last reply and the todo progress. */
export function buildSampleSummaries(): ReadonlyMap<number, RowSummary> {
  return new Map(
    (
      [
        [
          -11,
          translateUi(
            "sidebar.samples.checkoutTestReply",
            "The checkout test fails about one run in five; running it in a loop.",
          ),
          [2, 4],
        ],
        [
          -12,
          translateUi(
            "sidebar.samples.darkModeReply",
            "Wiring the toggle into the settings menu, then the color variables.",
          ),
          [3, 7],
        ],
        [
          -13,
          translateUi(
            "sidebar.samples.colorTokensReply",
            "14 tokens have no dark variant; the list is in tokens-audit.md.",
          ),
          null,
        ],
        [
          -14,
          translateUi(
            "sidebar.samples.sessionMiddlewareReply",
            "Done: auth and rate limiting are separate middlewares, 12 new tests.",
          ),
          [5, 5],
        ],
        [
          -21,
          translateUi(
            "sidebar.samples.billingWebhooksReply",
            "The webhook replay failed: Stripe answered 401 with the test key.",
          ),
          null,
        ],
        [
          -22,
          translateUi(
            "sidebar.samples.releaseNotesReply",
            "Release notes drafted in CHANGELOG.md, grouped by area.",
          ),
          null,
        ],
        [
          -31,
          translateUi("sidebar.samples.spacingScaleReply", "Should the scale start at 4 or 8 px?"),
          null,
        ],
        [
          -32,
          translateUi(
            "sidebar.samples.storybookUpgradeReply",
            "Running the Storybook 8 migration codemod.",
          ),
          [1, 5],
        ],
      ] as const
    ).map(([id, preview, todos]) => [
      id,
      { preview, todos: todos && { done: todos[0], total: todos[1] }, error: null },
    ]),
  );
}
