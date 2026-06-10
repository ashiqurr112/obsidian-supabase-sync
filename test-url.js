const url = "https://example.com/test 😄.md";
const safeUrl = new URL(url).href;
console.log(safeUrl);
