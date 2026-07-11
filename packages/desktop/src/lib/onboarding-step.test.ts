import { describe, it, expect } from "vitest";
import {
  COMPLETED_ONBOARDING_STEP,
  FIRST_ONBOARDING_STEP,
  TOTAL_ONBOARDING_STEPS,
  VISIBLE_ONBOARDING_STEPS,
  nextOnboardingStep,
  onboardingStepNumber,
  parseOnboardingStep,
  previousOnboardingStep,
} from "./onboarding-step";

describe("onboarding-step", () => {
  describe("parseOnboardingStep", () => {
    it("returns the value when it matches a known step", () => {
      expect(parseOnboardingStep("discover_cli")).toBe("discover_cli");
      expect(parseOnboardingStep("completed")).toBe("completed");
    });

    it("falls back to the first step for unknown / missing values", () => {
      expect(parseOnboardingStep(null)).toBe(FIRST_ONBOARDING_STEP);
      expect(parseOnboardingStep(undefined)).toBe(FIRST_ONBOARDING_STEP);
      expect(parseOnboardingStep("")).toBe(FIRST_ONBOARDING_STEP);
      expect(parseOnboardingStep("garbage")).toBe(FIRST_ONBOARDING_STEP);
    });
  });

  describe("nextOnboardingStep", () => {
    it("advances through every visible step into completed", () => {
      const order = [
        "welcome",
        "discover_cli",
        "choose_workspace",
        "pick_agent",
        "preferences",
        "first_prompt",
        "completed",
      ] as const;
      for (let i = 0; i < order.length - 1; i++) {
        expect(nextOnboardingStep(order[i]!)).toBe(order[i + 1]);
      }
    });

    it("stays on completed once we reach the terminal state", () => {
      expect(nextOnboardingStep(COMPLETED_ONBOARDING_STEP)).toBe(COMPLETED_ONBOARDING_STEP);
    });
  });

  describe("previousOnboardingStep", () => {
    it("walks back through every step", () => {
      expect(previousOnboardingStep("first_prompt")).toBe("preferences");
      expect(previousOnboardingStep("preferences")).toBe("pick_agent");
      expect(previousOnboardingStep("pick_agent")).toBe("choose_workspace");
      expect(previousOnboardingStep("choose_workspace")).toBe("discover_cli");
      expect(previousOnboardingStep("discover_cli")).toBe("welcome");
    });

    it("stays on welcome when called from welcome", () => {
      expect(previousOnboardingStep("welcome")).toBe("welcome");
    });
  });

  describe("onboardingStepNumber", () => {
    it("returns 1-based positions for visible steps", () => {
      expect(onboardingStepNumber("welcome")).toBe(1);
      expect(onboardingStepNumber("first_prompt")).toBe(TOTAL_ONBOARDING_STEPS);
    });

    it("clamps completed to the total step count", () => {
      expect(onboardingStepNumber("completed")).toBe(TOTAL_ONBOARDING_STEPS);
    });
  });

  it("VISIBLE_ONBOARDING_STEPS excludes completed and matches TOTAL_ONBOARDING_STEPS", () => {
    expect(VISIBLE_ONBOARDING_STEPS).not.toContain("completed");
    expect(VISIBLE_ONBOARDING_STEPS.length).toBe(TOTAL_ONBOARDING_STEPS);
  });
});
