import { expect, it } from "vitest";
import { uiI18n } from "@/lib/i18n/ui";
import { permissionOptionCopy } from "./permission-option-copy";

const showKey = uiI18n.getFixedT("cimode", "ui");

it("keys Cadencr's built-in approval copy without changing what the button sends", () => {
  const option = {
    decision: "allow_once",
    optionId: 'codex:"accept"',
    label: "Approve",
    description: "Approve this request only",
  };
  expect(permissionOptionCopy(showKey, option)).toEqual({
    label: "permission.option.approveRequest.label",
    description: "permission.option.approveRequest.description",
  });
  expect(option).toMatchObject({
    decision: "allow_once",
    optionId: 'codex:"accept"',
    label: "Approve",
  });
});

it.each([
  [
    "allow_always",
    "Always allow",
    "Approve similar requests in this and future sessions",
    "allowSimilar",
  ],
  ["reject_once", "Deny", "Reject this request", "denyRequest"],
])("keys the ACP default option %s", (optionId, label, description, kind) => {
  expect(permissionOptionCopy(showKey, { optionId, label, description })).toEqual({
    label: `permission.option.${kind}.label`,
    description: `permission.option.${kind}.description`,
  });
});

it("preserves provider-supplied wording and opaque custom options", () => {
  const custom = {
    label: "Approve",
    description: "Approve this request only",
    optionId: "my-plugin:confirm",
  };
  expect(permissionOptionCopy(showKey, custom)).toEqual({
    label: custom.label,
    description: custom.description,
  });
  const detail = { label: "Allow once", description: "Ask the reviewer before changing this file" };
  expect(permissionOptionCopy(showKey, detail)).toEqual(detail);
});
