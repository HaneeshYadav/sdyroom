import {
  aliasSchema,
  examTargetsSchema,
  languageSchema,
  onboardingSchema,
  updateProfileSchema,
} from "@/lib/validation/profile";
import { EXAM_TRACKS } from "@/lib/vocab/exam-tracks";
import { LANGUAGES } from "@/lib/vocab/languages";
import { describe, expect, it } from "vitest";

describe("aliasSchema", () => {
  it("trims the alias", () => {
    expect(aliasSchema.parse("  StudyBuddy  ")).toBe("StudyBuddy");
  });

  it("requires a non-empty alias", () => {
    expect(aliasSchema.safeParse("   ").success).toBe(false);
    expect(aliasSchema.safeParse("").success).toBe(false);
  });

  it("rejects aliases longer than 32 characters", () => {
    expect(aliasSchema.safeParse("a".repeat(33)).success).toBe(false);
    expect(aliasSchema.safeParse("a".repeat(32)).success).toBe(true);
  });

  it("accepts letters, numbers, spaces, hyphens and underscores", () => {
    expect(aliasSchema.parse("study-buddy_1")).toBe("study-buddy_1");
    expect(aliasSchema.parse("Exam Prep 2026")).toBe("Exam Prep 2026");
  });

  it("rejects aliases that do not start with a letter or number", () => {
    expect(aliasSchema.safeParse("_buddy").success).toBe(false);
    expect(aliasSchema.safeParse("@buddy").success).toBe(false);
    expect(aliasSchema.safeParse("budd!es").success).toBe(false);
  });
});

describe("onboardingSchema", () => {
  it("parses a valid alias payload", () => {
    expect(onboardingSchema.parse({ alias: " examnerd " })).toEqual({
      alias: "examnerd",
    });
  });

  it("reports the alias path on failure", () => {
    const result = onboardingSchema.safeParse({ alias: "" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["alias"]);
  });
});

describe("examTargetsSchema", () => {
  it("accepts an empty array (no targets)", () => {
    expect(examTargetsSchema.parse([])).toEqual([]);
  });

  it("accepts up to three selections from the shared vocabulary", () => {
    expect(examTargetsSchema.parse(["NEET", "JEE", "UPSC"])).toEqual([
      "NEET",
      "JEE",
      "UPSC",
    ]);
    for (const track of EXAM_TRACKS) {
      expect(examTargetsSchema.safeParse([track]).success).toBe(true);
    }
  });

  it("rejects more than three selections", () => {
    const tooMany = ["NEET", "JEE", "UPSC", "SSC"];
    const result = examTargetsSchema.safeParse(tooMany);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([]);
  });

  it("rejects a value outside the vocabulary", () => {
    const result = examTargetsSchema.safeParse(["anything"]);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path?.[0]).toBe(0);
  });

  it("rejects non-string entries", () => {
    expect(examTargetsSchema.safeParse([42]).success).toBe(false);
    expect(examTargetsSchema.safeParse(["NEET", null]).success).toBe(false);
  });
});

describe("languageSchema", () => {
  it("accepts every value of the shared vocabulary", () => {
    for (const language of LANGUAGES) {
      expect(languageSchema.safeParse(language).success).toBe(true);
    }
  });

  it("rejects values outside the vocabulary, including the empty string", () => {
    expect(languageSchema.safeParse("").success).toBe(false);
    expect(languageSchema.safeParse("Klingon").success).toBe(false);
  });
});

describe("updateProfileSchema", () => {
  it("accepts a partial body with only an alias", () => {
    expect(updateProfileSchema.parse({ alias: "  NewName  " })).toEqual({
      alias: "NewName",
    });
  });

  it("accepts targets only and language only, including null to clear", () => {
    expect(updateProfileSchema.parse({ exam_targets: ["JEE"] })).toEqual({
      exam_targets: ["JEE"],
    });
    expect(updateProfileSchema.parse({ language: null })).toEqual({
      language: null,
    });
    expect(updateProfileSchema.parse({ language: "English" })).toEqual({
      language: "English",
    });
  });

  it("rejects protected fields by name (strict body)", () => {
    for (const smuggled of [
      { email: "attacker@example.com" },
      { user_id: "someone-else" },
      { id: "00000000-0000-0000-0000-000000000000" },
      { created_at: "2020-01-01T00:00:00Z" },
      { updated_at: "2020-01-01T00:00:00Z" },
      { alias: "fine", admin: true },
    ]) {
      const result = updateProfileSchema.safeParse(smuggled);
      expect(result.success).toBe(false);
      expect(result.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(
        true,
      );
    }
  });

  it("applies the alias, targets and language rules inside the object", () => {
    expect(updateProfileSchema.safeParse({ alias: "" }).success).toBe(false);
    expect(
      updateProfileSchema.safeParse({ alias: "x".repeat(33) }).success,
    ).toBe(false);
    expect(
      updateProfileSchema.safeParse({ exam_targets: ["anything"] }).success,
    ).toBe(false);
    expect(updateProfileSchema.safeParse({ language: "Klingon" }).success).toBe(
      false,
    );
  });
});
