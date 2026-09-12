import { describe, expect, it } from "vitest";
import { importChanges, taskImage } from "./docker.js";

describe("importChanges", () => {
  it("reconstruit ENV, WORKDIR, ENTRYPOINT, CMD et LABEL", () => {
    expect(
      importChanges({
        Env: ["PATH=/root/.local/bin:/usr/bin", "IS_SANDBOX=1", "X=a b=c"],
        WorkingDir: "/work",
        Entrypoint: ["/bin/sh", "-c"],
        Cmd: ["bash"],
        Labels: { "unused.task": "review" },
      }),
    ).toEqual([
      'ENV PATH="/root/.local/bin:/usr/bin"',
      'ENV IS_SANDBOX="1"',
      'ENV X="a b=c"',
      "WORKDIR /work",
      'ENTRYPOINT ["/bin/sh","-c"]',
      'CMD ["bash"]',
      'LABEL unused.task="review"',
    ]);
  });

  it("tolère une config vide", () => {
    expect(importChanges({})).toEqual([]);
    expect(importChanges({ Env: null, Entrypoint: null, Cmd: null, Labels: null })).toEqual([]);
  });
});

describe("taskImage", () => {
  it("préfixe le nom de la tâche", () => {
    expect(taskImage("review")).toBe("unused-task-review");
  });
});
