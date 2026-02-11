import { describe, it } from "node:test";
import assert from "node:assert";

import { t } from "./i18n";

describe("i18n", () => {
  it("returns russian text by key", () => {
    assert.strictEqual(t("ru", "contestNotFound"), "Конкурс не найден.");
  });

  it("returns english text by key", () => {
    assert.strictEqual(t("en", "contestNotFound"), "Contest not found.");
  });

  it("applies interpolation variables", () => {
    assert.strictEqual(
      t("ru", "tooFrequent", { seconds: 3 }),
      "Слишком часто. Повторите через 3 сек.",
    );
    assert.strictEqual(t("en", "whoami", { userId: 42 }), "Your user ID: 42");
  });
});

