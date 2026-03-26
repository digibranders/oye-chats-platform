import sys
import asyncio
import json
import os
import io
import re
from urllib.parse import urlparse, urljoin

# Force stdin, stdout, stderr to use UTF-8 safely
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# Force Windows Proactor Policy
if sys.platform.startswith("win"):
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

def rgb_to_hex(r, g, b):
    """Convert RGB values to hex color string."""
    return "#{:02x}{:02x}{:02x}".format(int(r), int(g), int(b))

def hex_to_hsl(hex_color):
    """Convert hex color to HSL values."""
    hex_color = hex_color.lstrip('#')
    if len(hex_color) == 3:
        hex_color = ''.join(c * 2 for c in hex_color)
    r, g, b = int(hex_color[0:2], 16) / 255, int(hex_color[2:4], 16) / 255, int(hex_color[4:6], 16) / 255
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        s = 0
    else:
        d = mx - mn
        s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    return s * 100, l * 100

def is_brand_worthy(hex_color):
    """Check if a color is likely a brand color (not white/black/gray)."""
    try:
        s, l = hex_to_hsl(hex_color)
        if l > 95 or l < 5:
            return False
        if s < 5 and 20 < l < 80:
            return False
        return True
    except Exception:
        return False

def extract_colors_from_html(html_content):
    """
    Python-based fallback: extract brand colors directly from HTML/CSS.
    Parses inline styles, style tags, and common color attributes.
    """
    scores = {}

    def add_color(hex_color, weight):
        hex_color = hex_color.lower().strip()
        # Normalize 3-char hex to 6-char
        if len(hex_color) == 4:  # e.g. #f0a
            hex_color = '#' + ''.join(c * 2 for c in hex_color[1:])
        if len(hex_color) != 7 or not hex_color.startswith('#'):
            return
        if not is_brand_worthy(hex_color):
            return
        scores[hex_color] = scores.get(hex_color, 0) + weight

    def parse_rgb(match_str):
        """Convert rgb(r,g,b) or rgba(r,g,b,a) to hex."""
        nums = re.findall(r'[\d.]+', match_str)
        if len(nums) >= 3:
            try:
                return rgb_to_hex(float(nums[0]), float(nums[1]), float(nums[2]))
            except Exception:
                pass
        return None

    # 1. Extract all hex colors from the HTML
    hex_colors = re.findall(r'#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b', html_content)
    for c in hex_colors:
        add_color(c, 1)

    # 2. Extract rgb/rgba colors
    rgb_matches = re.findall(r'rgba?\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)', html_content)
    for m in rgb_matches:
        hex_c = parse_rgb(m)
        if hex_c:
            add_color(hex_c, 1)

    # 3. Higher weight for colors in brand-related contexts
    # Extract style blocks
    style_blocks = re.findall(r'<style[^>]*>(.*?)</style>', html_content, re.DOTALL | re.IGNORECASE)
    style_content = ' '.join(style_blocks)

    # Colors in CSS variables (--primary, --brand, --accent, etc.)
    css_var_colors = re.findall(
        r'--[\w-]*(?:primary|brand|accent|theme|main|color)[\w-]*\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)',
        style_content, re.IGNORECASE
    )
    for c in css_var_colors:
        add_color(c, 10)

    css_var_rgb = re.findall(
        r'--[\w-]*(?:primary|brand|accent|theme|main|color)[\w-]*\s*:\s*(rgba?\s*\([^)]+\))',
        style_content, re.IGNORECASE
    )
    for m in css_var_rgb:
        hex_c = parse_rgb(m)
        if hex_c:
            add_color(hex_c, 10)

    # 4. Colors in header/nav/button elements (higher weight)
    brand_patterns = [
        (r'<(?:header|nav)[^>]*(?:style|class)[^>]*>.*?</(?:header|nav)>', 8),
        (r'<(?:button|a)[^>]*(?:style|class)[^>]*>.*?</(?:button|a)>', 7),
        (r'class="[^"]*(?:brand|logo|accent|primary|cta|hero|banner)[^"]*"[^>]*style="[^"]*(?:background|color)\s*:\s*([^;"]+)', 9),
    ]
    for pattern, weight in brand_patterns:
        matches = re.findall(pattern, html_content, re.DOTALL | re.IGNORECASE)
        for match_text in matches:
            block = match_text if isinstance(match_text, str) else str(match_text)
            block_hex = re.findall(r'#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b', block)
            for c in block_hex:
                add_color(c, weight)
            block_rgb = re.findall(r'rgba?\s*\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)', block)
            for m in block_rgb:
                hex_c = parse_rgb(m)
                if hex_c:
                    add_color(hex_c, weight)

    # 5. Colors in background-color and color properties (medium weight)
    bg_colors = re.findall(r'background(?:-color)?\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)', style_content, re.IGNORECASE)
    for c in bg_colors:
        add_color(c, 5)

    fg_colors = re.findall(r'(?<!background-)color\s*:\s*(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)', style_content, re.IGNORECASE)
    for c in fg_colors:
        add_color(c, 3)

    # Sort by score and return top 6
    sorted_colors = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [c for c, _ in sorted_colors[:6]]


async def crawl_recursive(start_url, max_depth=3, max_pages=100):
    try:
        from crawl4ai import AsyncWebCrawler
    except ImportError:
        print(json.dumps({"error": "crawl4ai not installed"}))
        return

    # Helper to normalize domain (ignore www.)
    def get_base_domain(netloc):
        return netloc.replace("www.", "")

    start_domain = get_base_domain(urlparse(start_url).netloc)
    visited = set()
    queue = [(start_url, 0)] # (url, depth)
    results = []
    extracted_colors = set()

    print(json.dumps({"log": f"Starting recursive crawl on {start_url} (Base Domain: {start_domain}, Max Depth: {max_depth})"}))

    js_extraction_code = """
    (() => {
        function rgbToHex(rgb) {
            if (!rgb) return null;
            const m = rgb.match(/\\d+/g);
            if (!m || m.length < 3) return null;
            return "#" + m.slice(0, 3).map(x => {
                const h = parseInt(x).toString(16);
                return h.length === 1 ? "0" + h : h;
            }).join("");
        }

        function hexToHSL(hex) {
            let r = parseInt(hex.slice(1,3), 16) / 255;
            let g = parseInt(hex.slice(3,5), 16) / 255;
            let b = parseInt(hex.slice(5,7), 16) / 255;
            const max = Math.max(r,g,b), min = Math.min(r,g,b);
            let h, s, l = (max + min) / 2;
            if (max === min) { h = s = 0; }
            else {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                else if (max === g) h = ((b - r) / d + 2) / 6;
                else h = ((r - g) / d + 4) / 6;
            }
            return { h: h * 360, s: s * 100, l: l * 100 };
        }

        function isBrandWorthy(hex) {
            const { s, l } = hexToHSL(hex);
            if (l > 95 || l < 5) return false;
            if (s < 5 && l > 20 && l < 80) return false;
            return true;
        }

        const scores = {};
        function addColor(rgb, weight) {
            const hex = rgbToHex(rgb);
            if (!hex || !isBrandWorthy(hex)) return;
            const key = hex.toLowerCase();
            scores[key] = (scores[key] || 0) + weight;
        }

        // 1. Extract CSS custom properties (--primary, --brand, --accent, etc.)
        try {
            const rootStyles = getComputedStyle(document.documentElement);
            const sheets = document.styleSheets;
            const varNames = [];
            for (const sheet of sheets) {
                try {
                    for (const rule of sheet.cssRules || []) {
                        const text = rule.cssText || "";
                        const vars = text.match(/--[\\w-]*(primary|brand|accent|theme|main|color)[\\w-]*/gi);
                        if (vars) varNames.push(...vars);
                    }
                } catch(e) {}
            }
            for (const v of [...new Set(varNames)]) {
                const val = rootStyles.getPropertyValue(v).trim();
                if (val && val.match(/^(#|rgb)/)) addColor(val.startsWith("#") ? val : val, 10);
            }
        } catch(e) {}

        // 2. Extract from high-priority brand elements
        const brandSelectors = [
            { sel: "header, nav, [class*='header'], [class*='nav'], [class*='topbar']", w: 8 },
            { sel: "a, button, [class*='btn'], [class*='button'], [class*='cta']", w: 7 },
            { sel: "[class*='brand'], [class*='logo'], [class*='accent'], [class*='primary']", w: 9 },
            { sel: "footer, [class*='footer']", w: 5 },
            { sel: "h1, h2, h3", w: 4 },
            { sel: "[class*='hero'], [class*='banner'], [class*='jumbotron']", w: 6 }
        ];

        for (const { sel, w } of brandSelectors) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const cs = getComputedStyle(el);
                    const bg = cs.backgroundColor;
                    const fg = cs.color;
                    const border = cs.borderColor;
                    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") addColor(bg, w);
                    if (fg && fg !== "rgba(0, 0, 0, 0)" && fg !== "transparent") addColor(fg, w - 1);
                    if (border && border !== "rgba(0, 0, 0, 0)" && border !== "transparent") addColor(border, w - 2);
                }
            } catch(e) {}
        }

        // 3. Fallback: sample remaining elements with low weight
        const all = document.querySelectorAll("*");
        for (let i = 0; i < all.length; i += 5) {
            const cs = getComputedStyle(all[i]);
            const bg = cs.backgroundColor;
            if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") addColor(bg, 1);
        }

        // 4. Sort by score and return top 6
        const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        return sorted.slice(0, 6).map(e => e[0]);
    })();
    """

    async with AsyncWebCrawler(verbose=False) as crawler:
        while queue and len(visited) < max_pages:
            current_url, depth = queue.pop(0)
            
            # Normalize URL for visited check (remove trailing slash and www.)
            parsed_current = urlparse(current_url)
            norm_netloc = parsed_current.netloc.replace('www.', '')
            current_url_norm = parsed_current._replace(netloc=norm_netloc).geturl().rstrip('/')
            
            if current_url_norm in visited:
                continue
            
            visited.add(current_url_norm)
            print(json.dumps({"log": f"Crawling: {current_url} (Depth: {depth})"}))

            try:
                # Run JS extraction on the first page primarily, or every page and collect
                result = await crawler.arun(
                    url=current_url,
                    js_code=js_extraction_code if depth == 0 else None # Save time by only doing on root mostly
                )
                
                if result and result.markdown:
                    results.append({
                        "url": current_url_norm,
                        "content": result.markdown
                    })

                    # If we got colors from JS execution
                    if hasattr(result, "js_execution_result") and result.js_execution_result:
                        js_result = result.js_execution_result
                        # Handle both list and dict formats
                        if isinstance(js_result, list):
                            for c in js_result:
                                if isinstance(c, str):
                                    extracted_colors.add(c.lower())
                        elif isinstance(js_result, dict):
                            # Some crawl4ai versions wrap results in a dict
                            for val in js_result.values():
                                if isinstance(val, str) and val.startswith('#'):
                                    extracted_colors.add(val.lower())
                                elif isinstance(val, list):
                                    for c in val:
                                        if isinstance(c, str):
                                            extracted_colors.add(c.lower())

                    # Python fallback: extract colors from HTML if JS extraction found nothing
                    if depth == 0 and not extracted_colors and hasattr(result, "html") and result.html:
                        print(json.dumps({"log": "JS color extraction returned nothing, using Python HTML fallback"}))
                        fallback_colors = extract_colors_from_html(result.html)
                        for c in fallback_colors:
                            extracted_colors.add(c.lower())
                        if extracted_colors:
                            print(json.dumps({"log": f"Python fallback extracted {len(extracted_colors)} colors"}))
                    
                    # If not at max depth, find more links
                    if depth < max_depth:
                        links = []
                        
                        # Method 1: Try built-in result.links (crawl4ai dict)
                        if hasattr(result, "links") and isinstance(result.links, dict):
                            links_internal = result.links.get("internal", [])
                            for l in links_internal:
                                if isinstance(l, dict):
                                    links.append(l.get('href'))
                                elif isinstance(l, str):
                                    links.append(l)

                        # Method 2: Fallback to HTML parsing if Method 1 found nothing
                        if not links and hasattr(result, "html"):
                            import re
                            found_hrefs = re.findall(r'<a\s+(?:[^>]*?\s+)?href="([^"]*)"', result.html)
                            links.extend(found_hrefs)
                            print(json.dumps({"log": f"Fallback: Found {len(found_hrefs)} links via regex"}))
                        
                        for href in links:
                            if not href: continue
                            
                            full_url = urljoin(current_url, href)
                            parsed_url = urlparse(full_url)
                            
                            # Compare base domains
                            link_base_domain = get_base_domain(parsed_url.netloc)
                            
                            if link_base_domain == start_domain and parsed_url.scheme in ['http', 'https']:
                                # Normalize URL (remove fragment)
                                clean_url = full_url.split('#')[0].rstrip('/')
                                if clean_url not in visited:
                                    queue.append((clean_url, depth + 1))
                                        
            except Exception as e:
                print(json.dumps({"log": f"Error crawling {current_url}: {str(e)}"}))
                
    # Output results
    print("---CRAWLER_JSON_OUTPUT---")
    print(json.dumps({
        "results": results,
        "recommended_colors": list(extracted_colors)
    }))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        sys.exit(1)
        
    url = sys.argv[1]
    asyncio.run(crawl_recursive(url))
