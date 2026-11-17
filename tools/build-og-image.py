# Builds images/og-image.svg (source) and renders images/daniel-thompson-og-image.jpg (1200x630).
import base64, os, subprocess, re
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
mark = open(os.path.join(ROOT, 'images/dt-logo.svg')).read()
mark = re.sub(r'<animate[^>]*/>', '', re.search(r'<svg[^>]*>(.*)</svg>', mark, re.S).group(1))
photo = base64.b64encode(open(os.path.join(ROOT, 'images/dt-headshot2.png'), 'rb').read()).decode()
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(80 40) scale(820)"><stop offset="0" stop-color="#1e6b4a" stop-opacity=".45"/><stop offset="1" stop-color="#1e6b4a" stop-opacity="0"/></radialGradient>
    <radialGradient id="g2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1150 640) scale(600)"><stop offset="0" stop-color="#c9a84c" stop-opacity=".14"/><stop offset="1" stop-color="#c9a84c" stop-opacity="0"/></radialGradient>
    <clipPath id="c"><circle cx="930" cy="315" r="170"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#050d08"/>
  <rect width="1200" height="630" fill="url(#g1)"/>
  <rect width="1200" height="630" fill="url(#g2)"/>
  <g transform="translate(84 92) scale(2.1)">{mark}</g>
  <text x="90" y="330" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="68" font-weight="700" fill="#eef3ec" letter-spacing="-0.5">Daniel Thompson</text>
  <text x="92" y="392" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="30" fill="#8ea592">Digital strategy &amp; ecommerce growth</text>
  <text x="92" y="436" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="24" fill="#5f7a65">15 years in Australian ecommerce · Floreal, Mauritius</text>
  <text x="92" y="540" font-family="Menlo, Courier New, monospace" font-size="26" fill="#eef3ec">danielthompson</text>
  <text x="311" y="540" font-family="Menlo, Courier New, monospace" font-size="26" fill="#c9a84c">.digital</text>
  <circle cx="930" cy="315" r="178" fill="none" stroke="#7da87a" stroke-width="4" stroke-opacity=".7"/>
  <image x="760" y="105" width="340" height="415" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)" xlink:href="data:image/png;base64,{photo}" href="data:image/png;base64,{photo}"/>
</svg>'''
src = os.path.join(ROOT, 'images/og-image.svg')
open(src, 'w').write(svg)
subprocess.run(['sips', '-s', 'format', 'jpeg', '-s', 'formatOptions', '90', src, '--out', os.path.join(ROOT, 'images/daniel-thompson-og-image.jpg')], check=True, capture_output=True)
print('ok')
