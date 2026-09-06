from playwright.sync_api import sync_playwright
import json
ME = json.dumps({"playerId":"mike-d","pin":"1000"})
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width":390,"height":844}, device_scale_factor=2)
    pg = ctx.new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:8787/", wait_until="domcontentloaded")
    pg.evaluate(f"localStorage.setItem('pickem.me', '{ME}')")
    pg.reload(wait_until="networkidle"); pg.wait_for_timeout(1200)
    pg.screenshot(path="/tmp/t_head.png", clip={"x":0,"y":0,"width":390,"height":300})
    pg.click("[data-tab='standings']"); pg.wait_for_timeout(1500)
    pg.screenshot(path="/tmp/t_stand.png", full_page=True)
    print("ERRORS:", errs or "none")
    b.close()
