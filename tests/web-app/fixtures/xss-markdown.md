<script>window.xss = true</script>

<img src="https://attacker.example/pixel.png" onerror="window.xss = true">

<a href="javascript:window.xss=true" onclick="window.xss = true">bad javascript link</a>

[bad data link](data:text/html,<script>alert(1)</script>)

[good link](https://example.com)

`<img src=x onerror=alert(1)>`
