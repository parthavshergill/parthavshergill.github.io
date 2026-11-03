# Site editor (local only)

Edit the site in your browser and save straight back to the HTML files.

```sh
python3 tools/site-editor/serve.py          # then open http://localhost:4000/
python3 tools/site-editor/serve.py --open   # same, and opens the browser
```

Python 3.9+ with no extra packages. The server listens on `127.0.0.1` only.

## Use

1. Open any page and click **Edit page** (or add `?edit` to the URL).
2. Click into the text and type. Blocks you can edit have a dashed blue outline.
3. Press **⌘S / Ctrl+S** or **Save**. The page reloads from disk.
4. Click **Done** to see the page with its scripts running again.
5. Review with `git diff`, then commit and push as usual.

| To do this | Do this |
|---|---|
| Bold, italic, underline, strike | Toolbar or ⌘B / ⌘I / ⌘U |
| Heading, quote, code block | **¶ style** menu |
| Inline code | **</>** |
| Link | Select text, then 🔗 or ⌘K. Double-click a link to change or remove it. |
| Math | Put the cursor where it goes, click **∑**, and type LaTeX. Click rendered math to change it. |
| Image | Click **▣**, or paste or drop an image into the text. Click an image to set alt text, width, and caption. |
| Font for selected text | **Aa font** menu |
| Page fonts, size, line height, colors | **Page style** |
| Reorder, duplicate, or delete list items | Hover the item to show its controls |
| Mark a blog post as slop | Hover the post in the blog list and click **slop** |

## What it writes

- **Text edits:** only the blocks you changed. Everything you did not touch is copied back byte for byte from the file.
- **Images:** saved to `images/uploads/YYYYMMDD-name.ext` and linked with a relative path.
- **Math:** saved as rendered KaTeX HTML with the LaTeX in `data-tex`. The first math on a page adds the KaTeX stylesheet to `<head>`. Published pages need no JavaScript to show math.
- **Page style:** saved in one `<style id="site-style">` block in `<head>`. You can also edit or delete that block by hand.

## How it stays safe

- Edit mode turns the page's own scripts off, so script changes to the page never get saved into the file.
- Every save checks the file's hash. If the file changed on disk after the page loaded, the save stops.
- The server accepts only writes to block spans that it offered for the current file content.
- The editor code is added when the server sends the page. It is never written into your files.
