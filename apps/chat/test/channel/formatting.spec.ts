import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open, tag } from "./helpers";

/** Slack's composer formatting: the keys and the bar change the box, and the post carries and draws what the box showed. */

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function send(page: Page, key = "Enter"): Promise<string> {
  const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${FRONTEND}/send`) && r.method() === "POST");
  await page.keyboard.press(key);
  return ((await sent).postDataJSON() as { text: string }).text;
}

test("Ctrl+B, Ctrl+I and Ctrl+Shift+X send what the box shows, and the post draws it bold, italic and struck", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const word = tag();
  const input = composerInput(conversation(page));
  await input.focus();
  await page.keyboard.type(`plain ${word} `);
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type("loud");
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type(" ");
  await page.keyboard.press(`${mod}+i`);
  await page.keyboard.type("lean");
  await page.keyboard.press(`${mod}+i`);
  await page.keyboard.type(" ");
  await page.keyboard.press(`${mod}+Shift+x`);
  await page.keyboard.type("gone");
  await expect(input.locator("b")).toHaveText("loud");
  expect(await send(page)).toBe(`plain ${word} **loud** *lean* ~~gone~~`);
  const post = conversation(page).locator(".row.own").filter({ hasText: word });
  await expect(post.locator("strong")).toHaveText("loud");
  await expect(post.locator("em")).toHaveText("lean");
  await expect(post.locator("del")).toHaveText("gone");
});

test("the bar's buttons format the selection, show as pressed and keep the focus in the box", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const bar = conversation(page).getByTestId("format-bar");
  const input = composerInput(conversation(page));
  await input.focus();
  await page.keyboard.type("run the check");
  await page.keyboard.press("Shift+Home");
  await bar.getByRole("button", { name: "Code", exact: true }).click();
  await expect(input.locator("code")).toHaveText("run the check");
  await expect(input).toBeFocused();
  await expect(bar.getByRole("button", { name: "Code", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await send(page)).toBe("`run the check`");
});

test("lists, quotes and code blocks go out as markdown and render as Slack draws them", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const word = tag();
  const bar = conversation(page).getByTestId("format-bar");
  const input = composerInput(conversation(page));
  await input.focus();
  await page.keyboard.type(`steps ${word}`);
  await page.keyboard.press("Shift+Enter");
  await bar.getByRole("button", { name: "Bulleted list" }).click();
  await page.keyboard.type("one");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.press(`${mod}+Shift+9`);
  await page.keyboard.type("a quote");
  await expect(input.locator("ul li")).toHaveCount(2);
  await expect(input.locator("blockquote")).toHaveText("a quote");
  expect(await send(page)).toBe(`steps ${word}\n- one\n- two\n\n> a quote`);
  const post = conversation(page).locator(".row.own").filter({ hasText: word });
  await expect(post.locator("ul li")).toHaveText(["one", "two"]);
  await expect(post.locator("blockquote")).toContainText("a quote");

  await input.focus();
  await page.keyboard.press(`${mod}+Alt+Shift+c`);
  await page.keyboard.type("npm test");
  await page.keyboard.press("Enter");
  await page.keyboard.type("npm run build");
  await expect(input.locator("pre")).toContainText("npm run build");
  // Enter adds a line in a code block, as in Slack, so Cmd+Enter sends.
  expect(await send(page, `${mod}+Enter`)).toBe("```\nnpm test\nnpm run build\n```");
});

test("the link dialog links the selected text, and a pasted address over a selection links it too", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.focus();
  await page.keyboard.type("see the docs");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press(`${mod}+Shift+u`);
  const dialog = page.getByRole("dialog", { name: "Add link" });
  await expect(dialog.getByLabel("Text")).toHaveValue("docs");
  await dialog.getByLabel("Link").fill("slack.com/help");
  await dialog.getByLabel("Link").press("Enter");
  await expect(dialog).toBeHidden();
  await expect(input.locator("a")).toHaveAttribute("href", "https://slack.com/help");
  await expect(input).toBeFocused();
  expect(await send(page)).toBe("see the [docs](https://slack.com/help)");

  await input.focus();
  await page.keyboard.type("our site");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await input.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://example.com/a");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await send(page)).toBe("our [site](https://example.com/a)");
});

test("a saved draft comes back formatted after a reload", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  const input = composerInput(conversation(page));
  await input.focus();
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type("keep me");
  await page.keyboard.press(`${mod}+b`);
  await page.keyboard.type(" plain");
  await page.waitForTimeout(400);
  await page.reload();
  await expect(composerInput(conversation(page)).locator("b")).toHaveText("keep me");
  await expect(composerInput(conversation(page))).toHaveText("keep me plain");
  await composerInput(conversation(page)).focus();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.press("Delete");
});
