import { expect, test } from "@playwright/test";
import { composerInput, conversation, FRONTEND, open, tag } from "./helpers";

const pdf = { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") };

for (const where of ["thread", "channel"] as const) {
  test(`a PDF attached from the paperclip shows as a file card in the composer and in the ${where} post`, async ({ page, request }) => {
    const room = where === "thread"
      ? FRONTEND
      : ((await (await request.post("/api/rooms", { data: { kind: "channel", name: `files-${tag()}`, members: [], test: true } })).json()) as { id: string }).id;
    await open(page, `#/c/${room}`);
    const box = conversation(page);
    await box.locator('input[type="file"]').setInputFiles(pdf);
    const draft = box.locator(".attachments [data-testid=file-card]");
    await expect(draft).toContainText("report.pdf");
    await expect(draft).toContainText("PDF · 15 B");
    const word = `file ${tag()}`;
    await composerInput(box).click();
    await page.keyboard.type(word);
    const sent = page.waitForRequest((r) => r.url().includes(`/api/c/${room}/send`) && r.method() === "POST");
    await page.keyboard.press("Enter");
    const body = (await sent).postDataJSON() as { images: { url: string; mimeType: string; name: string; size: number }[] };
    expect(body.images).toEqual([expect.objectContaining({ mimeType: "application/pdf", name: "report.pdf", size: 15 })]);
    await expect(draft).toHaveCount(0);
    const card = box.locator(".row").filter({ hasText: word }).locator("[data-testid=file-card]");
    await expect(card).toContainText("report.pdf");
    const link = card.getByRole("link", { name: "report.pdf" });
    await expect(link).toHaveAttribute("href", /^\/api\/uploads\/[\w-]+\.pdf\?name=report\.pdf$/);
    const served = await request.get((await link.getAttribute("href"))!);
    expect(served.headers()["content-type"]).toBe("application/pdf");
    await page.reload();
    await expect(box.locator(".row").filter({ hasText: word }).locator("[data-testid=file-card]")).toContainText("PDF · 15 B");
    if (where === "channel") await request.patch(`/api/rooms/${room}`, { data: { archived: true } });
  });
}

test("a file over 40 MB is refused with its size before any upload", async ({ page }) => {
  await open(page, `#/c/${FRONTEND}`);
  let uploads = 0;
  page.on("request", (r) => void (r.url().includes("/api/uploads") && r.method() === "POST" && (uploads += 1)));
  await conversation(page).locator('input[type="file"]').setInputFiles({ name: "big.zip", mimeType: "application/zip", buffer: Buffer.alloc(41 * 1024 * 1024) });
  await expect(page.getByText("big.zip is 43 MB; a file can be up to 40 MB.")).toBeVisible();
  await expect(conversation(page).locator(".attachments")).toHaveCount(0);
  expect(uploads).toBe(0);
});
