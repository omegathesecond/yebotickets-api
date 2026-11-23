import workspace from "./workspace";
import { operations } from "./operations";

// The shared CEO frame renders labels and requires explicit bindings; it does
// not infer a resource identifier from a selected row.
it("supplies usable labels and record bindings to the existing CEO workspace", () => {
  const check = (section: any) => {
    expect(section.label).toEqual(expect.any(String));
    expect(section.label.trim()).not.toBe("");
    expect(operations[section.operation]).toBeDefined();
    if (section.detail) {
      expect(section.bind).toEqual({ id: "id" });
      expect(operations[section.detail]).toBeDefined();
    }
    for (const related of section.related || []) {
      check(related);
      expect(related.bind).toEqual({ id: "id" });
    }
  };
  workspace.sections.forEach(check);
  expect(new Set(workspace.sections.map((section) => section.id)).size).toBe(
    workspace.sections.length,
  );
  expect(
    workspace.sections.some((section) =>
      ["decisions", "activity", "chat"].includes(section.id),
    ),
  ).toBe(false);
});
