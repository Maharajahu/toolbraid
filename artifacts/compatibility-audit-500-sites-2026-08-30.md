# ToolBraid — audit live pe 500 de site-uri

Data: 30 august 2026
Browser: Google Chrome normal
Mod: read-only; fără clickuri, autentificări, formulare sau mutații externe

## Verdict

- **352 / 500 funcționează complet** pentru discovery, extracție, snapshot canonic și minimum un tool read.
- **39 / 500 sunt parțiale**: 4 challenge/blocaj de conținut, 18 shell-uri fără DOM util și 17 timeout-uri repetate.
- **109 / 500 sunt inaccesibile înainte de procesarea ToolBraid**: 78 probleme DNS/TLS/conexiune/blocaj client și 31 blocaje de policy/auth ale browserului.
- Pe cele 391 pagini accesibile, rata de compatibilitate completă este **90.0%**.
- **0 eșecuri ToolBraid de normalizare sau generare a descriptorilor** după obținerea unui DOM valid.
- 340 pagini funcționale au expus acțiuni candidate protejate prin approval; 12 au fost numai-citire.
- 16066 descriptori au fost generați pe paginile funcționale; 291 au expus media în inventarul DOM.

## Eșantion și metodă

Primele 100 de pagini sunt eșantionul public divers din auditul inițial. Domeniile 101–500 provin din [lista Tranco 64KYX](https://tranco-list.eu/list/64KYX/1000000), generată la 29 august 2026; au fost eliminate domeniile evidente de CDN/telemetrie, conținut adult/jocuri de noroc și domeniile deja testate. Intervalul Tranco folosit după filtrare este 12–656.

Pentru fiecare pagină s-a rulat exact extractorul de producție `extension/page-extractor.js`. Datele neautoritare au fost eliminate conform `boundedSnapshot()`, apoi s-au folosit exact `createPageSnapshot()` și `generateWebMcpToolDescriptors()`. Paginile goale, timeout-urile și erorile tranzitorii de control au fost retestate pe file Chrome proaspete, cu 4,5 secunde de hidratare. Pagina Baidu a fost recitită fragmentat pentru a elimina limita artificială de transport a harness-ului.

„Limite controlate” reprezintă plafoanele intenționate de dimensiune ale extractorului, nu o eroare. „Inaccesibil” nu este atribuit ToolBraid deoarece browserul nu a furnizat pagina. Nu a rămas nicio eroare tranzitorie de transport Chrome în verdictul final.

Auditul validează citirea și discovery live. Acțiunile mutate au fost numai descoperite; nu au fost executate.

## Rezultate complete

| # | Site | Tranco | Verdict | Read | Acțiuni | Text | Media | Observație |
|---:|---|---:|---|---:|---:|---:|---:|---|
| 1 | [Example](https://example.com/) | — | FUNCȚIONEAZĂ | 1 | 1 | 127 | 0 | OK |
| 2 | [Wikipedia](https://en.wikipedia.org/wiki/World_Wide_Web) | — | FUNCȚIONEAZĂ | 1 | 62 | 16384 | 3 | OK; limite controlate |
| 3 | [GitHub](https://github.com/openai/openai-python) | — | FUNCȚIONEAZĂ | 1 | 13 | 16384 | 0 | OK; limite controlate |
| 4 | [Vercel](https://vercel.com/) | — | FUNCȚIONEAZĂ | 1 | 49 | 557 | 1 | OK; limite controlate |
| 5 | [X](https://x.com/thsottiaux/status/2093515916076343774) | — | FUNCȚIONEAZĂ | 1 | 21 | 3020 | 3 | OK; limite controlate |
| 6 | [YouTube](https://www.youtube.com/) | — | FUNCȚIONEAZĂ | 1 | 0 | 4000 | 1 | OK; limite controlate |
| 7 | [TikTok](https://www.tiktok.com/) | — | FUNCȚIONEAZĂ | 1 | 25 | 469 | 2 | OK; limite controlate |
| 8 | [Reddit](https://www.reddit.com/r/programming/) | — | FUNCȚIONEAZĂ | 1 | 7 | 238 | 1 | OK |
| 9 | [Stack Overflow](https://stackoverflow.com/) | — | FUNCȚIONEAZĂ | 1 | 93 | 10810 | 1 | OK; limite controlate |
| 10 | [Hacker News](https://news.ycombinator.com/) | — | FUNCȚIONEAZĂ | 1 | 105 | 3539 | 1 | OK; limite controlate |
| 11 | [MDN](https://developer.mozilla.org/) | — | FUNCȚIONEAZĂ | 1 | 96 | 6826 | 1 | OK; limite controlate |
| 12 | [W3C](https://www.w3.org/) | — | FUNCȚIONEAZĂ | 1 | 104 | 1442 | 15 | OK; limite controlate |
| 13 | [Node.js](https://nodejs.org/) | — | FUNCȚIONEAZĂ | 1 | 16 | 2502 | 0 | OK; limite controlate |
| 14 | [Python](https://www.python.org/) | — | FUNCȚIONEAZĂ | 1 | 119 | 4703 | 1 | OK; limite controlate |
| 15 | [Rust](https://www.rust-lang.org/) | — | FUNCȚIONEAZĂ | 1 | 37 | 2452 | 9 | OK |
| 16 | [Go](https://go.dev/) | — | FUNCȚIONEAZĂ | 1 | 86 | 3410 | 38 | OK; limite controlate |
| 17 | [PHP](https://www.php.net/) | — | FUNCȚIONEAZĂ | 1 | 119 | 228 | 3 | OK; limite controlate |
| 18 | [Ruby](https://www.ruby-lang.org/) | — | FUNCȚIONEAZĂ | 1 | 43 | 3838 | 39 | OK; limite controlate |
| 19 | [Kotlin](https://kotlinlang.org/) | — | FUNCȚIONEAZĂ | 1 | 72 | 6130 | 10 | OK; limite controlate |
| 20 | [Swift](https://www.swift.org/) | — | FUNCȚIONEAZĂ | 1 | 23 | 4634 | 0 | OK; limite controlate |
| 21 | [React](https://react.dev/) | — | FUNCȚIONEAZĂ | 1 | 17 | 5293 | 2 | OK; limite controlate |
| 22 | [Vue](https://vuejs.org/) | — | FUNCȚIONEAZĂ | 1 | 79 | 1074 | 0 | OK; limite controlate |
| 23 | [Angular](https://angular.dev/) | — | FUNCȚIONEAZĂ | 1 | 31 | 1605 | 1 | OK; limite controlate |
| 24 | [Svelte](https://svelte.dev/) | — | FUNCȚIONEAZĂ | 1 | 119 | 1514 | 22 | OK; limite controlate |
| 25 | [Next.js](https://nextjs.org/) | — | FUNCȚIONEAZĂ | 1 | 42 | 4385 | 10 | OK; limite controlate |
| 26 | [Astro](https://astro.build/) | — | FUNCȚIONEAZĂ | 1 | 45 | 5096 | 1 | OK; limite controlate |
| 27 | [Tailwind CSS](https://tailwindcss.com/) | — | FUNCȚIONEAZĂ | 1 | 15 | 6915 | 1 | OK; limite controlate |
| 28 | [npm](https://www.npmjs.com/) | — | FUNCȚIONEAZĂ | 1 | 29 | 881 | 1 | OK |
| 29 | [PyPI](https://pypi.org/) | — | FUNCȚIONEAZĂ | 1 | 61 | 351 | 16 | OK |
| 30 | [crates.io](https://crates.io/) | — | FUNCȚIONEAZĂ | 1 | 38 | 4465 | 1 | OK; limite controlate |
| 31 | [Docker](https://www.docker.com/) | — | FUNCȚIONEAZĂ | 1 | 30 | 3224 | 1 | OK; limite controlate |
| 32 | [Kubernetes](https://kubernetes.io/) | — | FUNCȚIONEAZĂ | 1 | 79 | 1505 | 9 | OK; limite controlate |
| 33 | [Cloudflare](https://www.cloudflare.com/) | — | FUNCȚIONEAZĂ | 1 | 18 | 4976 | 2 | OK; limite controlate |
| 34 | [AWS](https://aws.amazon.com/) | — | FUNCȚIONEAZĂ | 1 | 10 | 7636 | 0 | OK; limite controlate |
| 35 | [Microsoft Azure](https://azure.microsoft.com/) | — | FUNCȚIONEAZĂ | 1 | 102 | 11793 | 1 | OK; limite controlate |
| 36 | [Google Cloud](https://cloud.google.com/) | — | FUNCȚIONEAZĂ | 1 | 41 | 16384 | 26 | OK; limite controlate |
| 37 | [Stripe](https://stripe.com/) | — | FUNCȚIONEAZĂ | 1 | 15 | 10451 | 1 | OK; limite controlate |
| 38 | [PayPal](https://www.paypal.com/) | — | FUNCȚIONEAZĂ | 1 | 41 | 4115 | 1 | OK; limite controlate |
| 39 | [Shopify](https://www.shopify.com/) | — | FUNCȚIONEAZĂ | 1 | 32 | 2177 | 17 | OK; limite controlate |
| 40 | [WordPress](https://wordpress.org/) | — | FUNCȚIONEAZĂ | 1 | 35 | 2185 | 2 | OK; limite controlate |
| 41 | [Drupal](https://www.drupal.org/) | — | INACCESIBIL | 1 | 1 | 117 | 2 | DNS/TLS/conexiune/blocaj client |
| 42 | [Webflow](https://webflow.com/) | — | FUNCȚIONEAZĂ | 1 | 55 | 16384 | 7 | OK; limite controlate |
| 43 | [Figma](https://www.figma.com/) | — | FUNCȚIONEAZĂ | 1 | 43 | 2517 | 2 | OK; limite controlate |
| 44 | [Canva](https://www.canva.com/) | — | FUNCȚIONEAZĂ | 1 | 5 | 134 | 1 | OK |
| 45 | [Notion](https://www.notion.so/product) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 46 | [Slack](https://slack.com/) | — | FUNCȚIONEAZĂ | 1 | 62 | 12894 | 39 | OK; limite controlate |
| 47 | [Discord](https://discord.com/) | — | FUNCȚIONEAZĂ | 1 | 67 | 8476 | 23 | OK; limite controlate |
| 48 | [Zoom](https://zoom.us/) | — | FUNCȚIONEAZĂ | 1 | 106 | 7787 | 11 | OK; limite controlate |
| 49 | [Dropbox](https://www.dropbox.com/) | — | FUNCȚIONEAZĂ | 1 | 0 | 754 | 0 | OK; limite controlate |
| 50 | [Box](https://www.box.com/) | — | FUNCȚIONEAZĂ | 1 | 38 | 5676 | 21 | OK; limite controlate |
| 51 | [OpenAI](https://openai.com/) | — | FUNCȚIONEAZĂ | 1 | 26 | 3622 | 4 | OK; limite controlate |
| 52 | [Anthropic](https://www.anthropic.com/) | — | FUNCȚIONEAZĂ | 1 | 51 | 16384 | 0 | OK; limite controlate |
| 53 | [Google DeepMind](https://deepmind.google/) | — | FUNCȚIONEAZĂ | 1 | 24 | 5636 | 20 | OK; limite controlate |
| 54 | [Hugging Face](https://huggingface.co/) | — | FUNCȚIONEAZĂ | 1 | 42 | 3477 | 6 | OK; limite controlate |
| 55 | [Perplexity](https://www.perplexity.ai/) | — | FUNCȚIONEAZĂ | 1 | 20 | 276 | 0 | OK; limite controlate |
| 56 | [Mistral AI](https://mistral.ai/) | — | FUNCȚIONEAZĂ | 1 | 29 | 8627 | 6 | OK; limite controlate |
| 57 | [Cohere](https://cohere.com/) | — | FUNCȚIONEAZĂ | 1 | 45 | 6631 | 3 | OK; limite controlate |
| 58 | [Ollama](https://ollama.com/) | — | FUNCȚIONEAZĂ | 1 | 43 | 1543 | 53 | OK |
| 59 | [arXiv](https://arxiv.org/) | — | FUNCȚIONEAZĂ | 1 | 119 | 4982 | 1 | OK; limite controlate |
| 60 | [Nature](https://www.nature.com/) | — | FUNCȚIONEAZĂ | 1 | 66 | 216 | 6 | OK; limite controlate |
| 61 | [Science](https://www.science.org/) | — | FUNCȚIONEAZĂ | 1 | 62 | 9681 | 10 | OK; limite controlate |
| 62 | [BBC](https://www.bbc.com/) | — | FUNCȚIONEAZĂ | 1 | 38 | 11538 | 2 | OK; limite controlate |
| 63 | [CNN](https://www.cnn.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 64 | [Reuters](https://www.reuters.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 65 | [The Guardian](https://www.theguardian.com/) | — | FUNCȚIONEAZĂ | 1 | 11 | 1027 | 2 | OK |
| 66 | [The New York Times](https://www.nytimes.com/) | — | INACCESIBIL | 1 | 62 | 9681 | 10 | Politică browser sau redirect autentificare |
| 67 | [Bloomberg](https://www.bloomberg.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 68 | [NPR](https://www.npr.org/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 69 | [AP News](https://apnews.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 70 | [Al Jazeera](https://www.aljazeera.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 71 | [IMDb](https://www.imdb.com/) | — | FUNCȚIONEAZĂ | 1 | 47 | 16384 | 1 | OK; limite controlate |
| 72 | [Spotify](https://open.spotify.com/) | — | FUNCȚIONEAZĂ | 1 | 29 | 1452 | 2 | OK; limite controlate |
| 73 | [SoundCloud](https://soundcloud.com/) | — | FUNCȚIONEAZĂ | 1 | 36 | 13006 | 1 | OK; limite controlate |
| 74 | [Twitch](https://www.twitch.tv/) | — | FUNCȚIONEAZĂ | 1 | 25 | 975 | 11 | OK; limite controlate |
| 75 | [Vimeo](https://vimeo.com/) | — | FUNCȚIONEAZĂ | 1 | 31 | 6697 | 26 | OK; limite controlate |
| 76 | [Dailymotion](https://www.dailymotion.com/) | — | FUNCȚIONEAZĂ | 1 | 44 | 3640 | 15 | OK; limite controlate |
| 77 | [Pinterest](https://www.pinterest.com/) | — | FUNCȚIONEAZĂ | 1 | 15 | 1899 | 3 | OK; limite controlate |
| 78 | [Instagram](https://www.instagram.com/) | — | FUNCȚIONEAZĂ | 1 | 7 | 549 | 2 | OK; limite controlate |
| 79 | [Facebook](https://www.facebook.com/) | — | FUNCȚIONEAZĂ | 1 | 33 | 1344 | 0 | OK; limite controlate |
| 80 | [LinkedIn](https://www.linkedin.com/) | — | FUNCȚIONEAZĂ | 1 | 68 | 3601 | 1 | OK; limite controlate |
| 81 | [eBay](https://www.ebay.com/) | — | FUNCȚIONEAZĂ | 1 | 58 | 271 | 25 | OK; limite controlate |
| 82 | [Etsy](https://www.etsy.com/) | — | FUNCȚIONEAZĂ | 1 | 27 | 0 | 9 | OK; limite controlate |
| 83 | [Amazon UK](https://www.amazon.co.uk/) | — | FUNCȚIONEAZĂ | 1 | 38 | 16384 | 1 | OK; limite controlate |
| 84 | [Walmart](https://www.walmart.com/) | — | FUNCȚIONEAZĂ | 1 | 4 | 4816 | 2 | OK; limite controlate |
| 85 | [IKEA](https://www.ikea.com/) | — | FUNCȚIONEAZĂ | 1 | 24 | 1248 | 9 | OK; limite controlate |
| 86 | [Booking.com](https://www.booking.com/) | — | FUNCȚIONEAZĂ | 1 | 11 | 7957 | 1 | OK; limite controlate |
| 87 | [Airbnb](https://www.airbnb.com/) | — | FUNCȚIONEAZĂ | 1 | 8 | 2119 | 8 | OK; limite controlate |
| 88 | [Tripadvisor](https://www.tripadvisor.com/) | — | FUNCȚIONEAZĂ | 1 | 23 | 3826 | 8 | OK; limite controlate |
| 89 | [Expedia](https://www.expedia.com/) | — | FUNCȚIONEAZĂ | 1 | 31 | 4106 | 8 | OK; limite controlate |
| 90 | [GOV.UK](https://www.gov.uk/) | — | FUNCȚIONEAZĂ | 1 | 60 | 2758 | 1 | OK; limite controlate |
| 91 | [NHS](https://www.nhs.uk/) | — | FUNCȚIONEAZĂ | 1 | 55 | 1725 | 0 | OK |
| 92 | [European Union](https://european-union.europa.eu/) | — | FUNCȚIONEAZĂ | 1 | 71 | 2402 | 2 | OK; limite controlate |
| 93 | [NASA](https://www.nasa.gov/) | — | FUNCȚIONEAZĂ | 1 | 53 | 4250 | 4 | OK; limite controlate |
| 94 | [The Weather Channel](https://weather.com/) | — | FUNCȚIONEAZĂ | 1 | 27 | 2739 | 10 | OK; limite controlate |
| 95 | [AccuWeather](https://www.accuweather.com/) | — | FUNCȚIONEAZĂ | 1 | 46 | 5892 | 2 | OK; limite controlate |
| 96 | [DuckDuckGo](https://duckduckgo.com/) | — | FUNCȚIONEAZĂ | 1 | 26 | 5166 | 19 | OK; limite controlate |
| 97 | [Bing](https://www.bing.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 98 | [Google](https://www.google.com/) | — | FUNCȚIONEAZĂ | 1 | 10 | 5549 | 7 | OK; limite controlate |
| 99 | [Apple](https://www.apple.com/) | — | FUNCȚIONEAZĂ | 1 | 60 | 5528 | 4 | OK; limite controlate |
| 100 | [Microsoft](https://www.microsoft.com/) | — | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 101 | [mail.ru](https://mail.ru/) | 12 | FUNCȚIONEAZĂ | 1 | 7 | 11076 | 5 | OK; limite controlate |
| 102 | [twitter.com](https://twitter.com/) | 16 | FUNCȚIONEAZĂ | 1 | 28 | 2356 | 4 | OK; limite controlate |
| 103 | [dzen.ru](https://dzen.ru/) | 17 | INACCESIBIL | 1 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 104 | [office.com](https://office.com/) | 21 | FUNCȚIONEAZĂ | 1 | 119 | 2967 | 1 | OK; limite controlate |
| 105 | [live.com](https://live.com/) | 24 | FUNCȚIONEAZĂ | 1 | 61 | 15082 | 6 | OK; limite controlate |
| 106 | [azure.com](https://azure.com/) | 28 | FUNCȚIONEAZĂ | 1 | 102 | 11793 | 1 | OK; limite controlate |
| 107 | [netflix.com](https://netflix.com/) | 41 | PARȚIAL | 1 | 2 | 3835 | 2 | Challenge/blocaj de conținut |
| 108 | [gandi.net](https://gandi.net/) | 43 | FUNCȚIONEAZĂ | 1 | 59 | 12849 | 0 | OK; limite controlate |
| 109 | [sharepoint.com](https://sharepoint.com/) | 44 | FUNCȚIONEAZĂ | 1 | 49 | 10619 | 2 | OK; limite controlate |
| 110 | [digicert.com](https://digicert.com/) | 46 | FUNCȚIONEAZĂ | 1 | 91 | 4993 | 29 | OK; limite controlate |
| 111 | [skype.com](https://skype.com/) | 48 | FUNCȚIONEAZĂ | 1 | 21 | 1045 | 42 | OK |
| 112 | [icloud.com](https://icloud.com/) | 54 | FUNCȚIONEAZĂ | 1 | 10 | 522 | 5 | OK |
| 113 | [whatsapp.com](https://whatsapp.com/) | 57 | FUNCȚIONEAZĂ | 1 | 25 | 176 | 0 | OK; limite controlate |
| 114 | [roblox.com](https://roblox.com/) | 58 | FUNCȚIONEAZĂ | 1 | 21 | 1875 | 14 | OK; limite controlate |
| 115 | [yahoo.com](https://yahoo.com/) | 59 | FUNCȚIONEAZĂ | 1 | 9 | 922 | 6 | OK |
| 116 | [msn.com](https://msn.com/) | 64 | FUNCȚIONEAZĂ | 1 | 24 | 2121 | 11 | OK; limite controlate |
| 117 | [adobe.com](https://adobe.com/) | 68 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 118 | [nginx.org](https://nginx.org/) | 74 | FUNCȚIONEAZĂ | 1 | 52 | 678 | 5 | OK |
| 119 | [chatgpt.com](https://chatgpt.com/) | 76 | FUNCȚIONEAZĂ | 1 | 0 | 1337 | 0 | OK; limite controlate |
| 120 | [baidu.com](https://baidu.com/) | 82 | FUNCȚIONEAZĂ | 1 | 47 | 16383 | 17 | OK; limite controlate |
| 121 | [windows.com](https://windows.com/) | 87 | FUNCȚIONEAZĂ | 1 | 119 | 2525 | 2 | OK; limite controlate |
| 122 | [qq.com](https://qq.com/) | 88 | FUNCȚIONEAZĂ | 1 | 76 | 7582 | 5 | OK; limite controlate |
| 123 | [opera.com](https://opera.com/) | 92 | FUNCȚIONEAZĂ | 1 | 44 | 2158 | 13 | OK; limite controlate |
| 124 | [blogspot.com](https://blogspot.com/) | 93 | FUNCȚIONEAZĂ | 1 | 17 | 1208 | 42 | OK |
| 125 | [samsung.com](https://samsung.com/) | 94 | FUNCȚIONEAZĂ | 1 | 0 | 5534 | 1 | OK; limite controlate |
| 126 | [nginx.com](https://nginx.com/) | 95 | FUNCȚIONEAZĂ | 1 | 113 | 7070 | 0 | OK; limite controlate |
| 127 | [wordpress.com](https://wordpress.com/) | 98 | FUNCȚIONEAZĂ | 1 | 78 | 3194 | 0 | OK; limite controlate |
| 128 | [yandex.ru](https://yandex.ru/) | 99 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 129 | [capgemini.com](https://capgemini.com/) | 101 | FUNCȚIONEAZĂ | 1 | 78 | 9067 | 2 | OK; limite controlate |
| 130 | [nic.ru](https://nic.ru/) | 103 | FUNCȚIONEAZĂ | 1 | 54 | 89 | 10 | OK; limite controlate |
| 131 | [achmea.nl](https://achmea.nl/) | 104 | FUNCȚIONEAZĂ | 1 | 58 | 1679 | 20 | OK; limite controlate |
| 132 | [ui.com](https://ui.com/) | 106 | FUNCȚIONEAZĂ | 1 | 29 | 2010 | 5 | OK; limite controlate |
| 133 | [office365.com](https://office365.com/) | 110 | FUNCȚIONEAZĂ | 1 | 0 | 86 | 0 | OK |
| 134 | [outlook.com](https://outlook.com/) | 115 | FUNCȚIONEAZĂ | 1 | 61 | 15082 | 6 | OK; limite controlate |
| 135 | [vk.com](https://vk.com/) | 119 | INACCESIBIL | 1 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 136 | [f5.com](https://f5.com/) | 120 | FUNCȚIONEAZĂ | 1 | 88 | 7741 | 0 | OK; limite controlate |
| 137 | [afternic.com](https://afternic.com/) | 121 | FUNCȚIONEAZĂ | 1 | 37 | 1182 | 16 | OK; limite controlate |
| 138 | [apache.org](https://apache.org/) | 126 | FUNCȚIONEAZĂ | 1 | 100 | 7116 | 29 | OK; limite controlate |
| 139 | [snapchat.com](https://snapchat.com/) | 131 | FUNCȚIONEAZĂ | 1 | 78 | 2263 | 4 | OK; limite controlate |
| 140 | [unity3d.com](https://unity3d.com/) | 132 | FUNCȚIONEAZĂ | 1 | 22 | 8182 | 1 | OK; limite controlate |
| 141 | [nih.gov](https://nih.gov/) | 136 | FUNCȚIONEAZĂ | 1 | 71 | 963 | 8 | OK; limite controlate |
| 142 | [kaspersky.com](https://kaspersky.com/) | 141 | PARȚIAL | 1 | 18 | 16384 | 5 | Challenge/blocaj de conținut |
| 143 | [iiko.it](https://iiko.it/) | 142 | INACCESIBIL | 1 | 2 | 117 | 2 | DNS/TLS/conexiune/blocaj client |
| 144 | [miit.gov.cn](https://miit.gov.cn/) | 144 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 145 | [intuit.com](https://intuit.com/) | 145 | FUNCȚIONEAZĂ | 1 | 19 | 5138 | 0 | OK; limite controlate |
| 146 | [reg.ru](https://reg.ru/) | 148 | FUNCȚIONEAZĂ | 1 | 31 | 177 | 0 | OK; limite controlate |
| 147 | [archive.org](https://archive.org/) | 150 | FUNCȚIONEAZĂ | 1 | 17 | 352 | 2 | OK |
| 148 | [epicgames.com](https://epicgames.com/) | 151 | FUNCȚIONEAZĂ | 1 | 41 | 6023 | 1 | OK; limite controlate |
| 149 | [godaddy.com](https://godaddy.com/) | 152 | FUNCȚIONEAZĂ | 1 | 50 | 6044 | 5 | OK; limite controlate |
| 150 | [xiaomi.com](https://xiaomi.com/) | 155 | FUNCȚIONEAZĂ | 1 | 15 | 6596 | 19 | OK; limite controlate |
| 151 | [tumblr.com](https://tumblr.com/) | 159 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 152 | [vk.ru](https://vk.ru/) | 172 | INACCESIBIL | 1 | 18 | 16384 | 5 | Politică browser sau redirect autentificare |
| 153 | [webex.com](https://webex.com/) | 177 | FUNCȚIONEAZĂ | 1 | 81 | 10588 | 16 | OK; limite controlate |
| 154 | [mts.ru](https://mts.ru/) | 178 | FUNCȚIONEAZĂ | 1 | 20 | 45 | 6 | OK; limite controlate |
| 155 | [ack.de](https://ack.de/) | 179 | INACCESIBIL | 1 | 2 | 115 | 2 | DNS/TLS/conexiune/blocaj client |
| 156 | [macromedia.com](https://macromedia.com/) | 182 | PARȚIAL | 1 | 4 | 593 | 2 | Timeout repetat la navigare |
| 157 | [flickr.com](https://flickr.com/) | 183 | FUNCȚIONEAZĂ | 1 | 75 | 1442 | 18 | OK; limite controlate |
| 158 | [hichina.com](https://hichina.com/) | 188 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 159 | [medium.com](https://medium.com/) | 191 | FUNCȚIONEAZĂ | 1 | 28 | 276 | 1 | OK |
| 160 | [vungle.com](https://vungle.com/) | 195 | FUNCȚIONEAZĂ | 1 | 80 | 3095 | 11 | OK; limite controlate |
| 161 | [creativecommons.org](https://creativecommons.org/) | 196 | FUNCȚIONEAZĂ | 1 | 119 | 2438 | 14 | OK |
| 162 | [oracle.com](https://oracle.com/) | 199 | FUNCȚIONEAZĂ | 1 | 36 | 4895 | 5 | OK; limite controlate |
| 163 | [miui.com](https://miui.com/) | 205 | FUNCȚIONEAZĂ | 1 | 7 | 6349 | 33 | OK; limite controlate |
| 164 | [forbes.com](https://forbes.com/) | 206 | FUNCȚIONEAZĂ | 1 | 57 | 16384 | 1 | OK; limite controlate |
| 165 | [doi.org](https://doi.org/) | 207 | FUNCȚIONEAZĂ | 1 | 31 | 2337 | 5 | OK |
| 166 | [t-online.de](https://t-online.de/) | 210 | FUNCȚIONEAZĂ | 1 | 101 | 7279 | 10 | OK; limite controlate |
| 167 | [sciencedirect.com](https://sciencedirect.com/) | 215 | FUNCȚIONEAZĂ | 1 | 47 | 5723 | 3 | OK; limite controlate |
| 168 | [mit.edu](https://mit.edu/) | 216 | FUNCȚIONEAZĂ | 1 | 77 | 2062 | 7 | OK |
| 169 | [comcast.net](https://comcast.net/) | 217 | FUNCȚIONEAZĂ | 1 | 31 | 8458 | 0 | OK; limite controlate |
| 170 | [cpanel.net](https://cpanel.net/) | 218 | FUNCȚIONEAZĂ | 1 | 43 | 2686 | 2 | OK; limite controlate |
| 171 | [researchgate.net](https://researchgate.net/) | 219 | FUNCȚIONEAZĂ | 1 | 38 | 1817 | 3 | OK |
| 172 | [gmail.com](https://gmail.com/) | 220 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 173 | [bbc.co.uk](https://bbc.co.uk/) | 226 | FUNCȚIONEAZĂ | 1 | 39 | 11409 | 2 | OK; limite controlate |
| 174 | [ozon.ru](https://ozon.ru/) | 227 | FUNCȚIONEAZĂ | 1 | 2 | 186 | 1 | OK |
| 175 | [nist.gov](https://nist.gov/) | 228 | FUNCȚIONEAZĂ | 1 | 104 | 79 | 6 | OK; limite controlate |
| 176 | [ubuntu.com](https://ubuntu.com/) | 232 | FUNCȚIONEAZĂ | 1 | 79 | 13877 | 10 | OK; limite controlate |
| 177 | [userapi.com](https://userapi.com/) | 234 | INACCESIBIL | 1 | 47 | 5723 | 3 | Politică browser sau redirect autentificare |
| 178 | [sourceforge.net](https://sourceforge.net/) | 236 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 179 | [telecid.ru](https://telecid.ru/) | 241 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 180 | [android.com](https://android.com/) | 242 | FUNCȚIONEAZĂ | 1 | 14 | 3087 | 7 | OK; limite controlate |
| 181 | [arubanetworks.com](https://arubanetworks.com/) | 243 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 182 | [name-services.com](https://name-services.com/) | 244 | INACCESIBIL | 1 | 2 | 137 | 2 | DNS/TLS/conexiune/blocaj client |
| 183 | [wsdvs.com](https://wsdvs.com/) | 245 | INACCESIBIL | 1 | 2 | 121 | 2 | DNS/TLS/conexiune/blocaj client |
| 184 | [telegram.org](https://telegram.org/) | 246 | FUNCȚIONEAZĂ | 1 | 62 | 1373 | 4 | OK |
| 185 | [cisco.com](https://cisco.com/) | 248 | FUNCȚIONEAZĂ | 1 | 44 | 8209 | 5 | OK; limite controlate |
| 186 | [wikimedia.org](https://wikimedia.org/) | 249 | FUNCȚIONEAZĂ | 1 | 22 | 1036 | 16 | OK |
| 187 | [hubspot.com](https://hubspot.com/) | 250 | FUNCȚIONEAZĂ | 1 | 30 | 11375 | 2 | OK; limite controlate |
| 188 | [who.int](https://who.int/) | 253 | FUNCȚIONEAZĂ | 1 | 35 | 6609 | 12 | OK; limite controlate |
| 189 | [omtrdc.net](https://omtrdc.net/) | 256 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 190 | [wixsite.com](https://wixsite.com/) | 257 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 191 | [launchpad.net](https://launchpad.net/) | 260 | FUNCȚIONEAZĂ | 1 | 33 | 1973 | 13 | OK |
| 192 | [meraki.com](https://meraki.com/) | 261 | FUNCȚIONEAZĂ | 1 | 60 | 6547 | 5 | OK; limite controlate |
| 193 | [linktr.ee](https://linktr.ee/) | 262 | FUNCȚIONEAZĂ | 1 | 8 | 3522 | 5 | OK; limite controlate |
| 194 | [roku.com](https://roku.com/) | 263 | FUNCȚIONEAZĂ | 1 | 52 | 742 | 24 | OK; limite controlate |
| 195 | [imcmdb.net](https://imcmdb.net/) | 264 | PARȚIAL | 1 | 4 | 585 | 2 | Timeout repetat la navigare |
| 196 | [hcaptcha.com](https://hcaptcha.com/) | 265 | PARȚIAL | 1 | 0 | 16384 | 0 | Challenge/blocaj de conținut |
| 197 | [ibm.com](https://ibm.com/) | 268 | FUNCȚIONEAZĂ | 1 | 37 | 6881 | 1 | OK; limite controlate |
| 198 | [facebook.net](https://facebook.net/) | 270 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 199 | [ttvnw.net](https://ttvnw.net/) | 271 | INACCESIBIL | 1 | 2 | 121 | 2 | DNS/TLS/conexiune/blocaj client |
| 200 | [triplinkintl.com](https://triplinkintl.com/) | 272 | FUNCȚIONEAZĂ | 1 | 20 | 780 | 19 | OK |
| 201 | [springer.com](https://springer.com/) | 274 | FUNCȚIONEAZĂ | 1 | 7 | 7201 | 0 | OK; limite controlate |
| 202 | [forter.com](https://forter.com/) | 276 | FUNCȚIONEAZĂ | 1 | 6 | 9768 | 0 | OK; limite controlate |
| 203 | [tinyurl.com](https://tinyurl.com/) | 277 | FUNCȚIONEAZĂ | 1 | 21 | 4924 | 12 | OK; limite controlate |
| 204 | [mangosip.ru](https://mangosip.ru/) | 278 | PARȚIAL | 1 | 4 | 587 | 2 | Timeout repetat la navigare |
| 205 | [weibo.com](https://weibo.com/) | 283 | FUNCȚIONEAZĂ | 1 | 43 | 729 | 8 | OK; limite controlate |
| 206 | [mozilla.com](https://mozilla.com/) | 284 | FUNCȚIONEAZĂ | 1 | 61 | 6768 | 11 | OK; limite controlate |
| 207 | [hp.com](https://hp.com/) | 287 | FUNCȚIONEAZĂ | 1 | 49 | 8909 | 12 | OK; limite controlate |
| 208 | [2mdn.net](https://2mdn.net/) | 289 | INACCESIBIL | 1 | 2 | 119 | 2 | DNS/TLS/conexiune/blocaj client |
| 209 | [harvard.edu](https://harvard.edu/) | 290 | FUNCȚIONEAZĂ | 1 | 69 | 4555 | 0 | OK; limite controlate |
| 210 | [debian.org](https://debian.org/) | 292 | FUNCȚIONEAZĂ | 1 | 47 | 16 | 17 | OK |
| 211 | [inmobi.com](https://inmobi.com/) | 294 | FUNCȚIONEAZĂ | 1 | 24 | 1550 | 40 | OK |
| 212 | [hostgator.com](https://hostgator.com/) | 295 | FUNCȚIONEAZĂ | 1 | 35 | 16384 | 0 | OK; limite controlate |
| 213 | [steampowered.com](https://steampowered.com/) | 298 | FUNCȚIONEAZĂ | 1 | 87 | 10899 | 9 | OK; limite controlate |
| 214 | [media-amazon.com](https://media-amazon.com/) | 300 | INACCESIBIL | 1 | 2 | 135 | 2 | DNS/TLS/conexiune/blocaj client |
| 215 | [alibaba.com](https://alibaba.com/) | 304 | FUNCȚIONEAZĂ | 1 | 1 | 9866 | 1 | OK; limite controlate |
| 216 | [wildberries.ru](https://wildberries.ru/) | 305 | FUNCȚIONEAZĂ | 1 | 40 | 8239 | 1 | OK; limite controlate |
| 217 | [autodesk.com](https://autodesk.com/) | 306 | FUNCȚIONEAZĂ | 1 | 18 | 3519 | 15 | OK; limite controlate |
| 218 | [wiley.com](https://wiley.com/) | 307 | FUNCȚIONEAZĂ | 1 | 18 | 10958 | 0 | OK; limite controlate |
| 219 | [telegram.me](https://telegram.me/) | 308 | FUNCȚIONEAZĂ | 1 | 62 | 1373 | 4 | OK |
| 220 | [samsungcloud.com](https://samsungcloud.com/) | 309 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 221 | [ok.ru](https://ok.ru/) | 311 | FUNCȚIONEAZĂ | 1 | 0 | 1709 | 0 | OK; limite controlate |
| 222 | [avast.com](https://avast.com/) | 312 | FUNCȚIONEAZĂ | 1 | 55 | 10926 | 35 | OK; limite controlate |
| 223 | [drom.ru](https://drom.ru/) | 313 | FUNCȚIONEAZĂ | 1 | 70 | 5171 | 46 | OK; limite controlate |
| 224 | [crpt.ru](https://crpt.ru/) | 314 | FUNCȚIONEAZĂ | 1 | 57 | 1859 | 9 | OK; limite controlate |
| 225 | [capcutapi.com](https://capcutapi.com/) | 315 | INACCESIBIL | 1 | 2 | 129 | 2 | DNS/TLS/conexiune/blocaj client |
| 226 | [virginm.net](https://virginm.net/) | 317 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 227 | [ea.com](https://ea.com/) | 319 | FUNCȚIONEAZĂ | 1 | 37 | 6600 | 9 | OK; limite controlate |
| 228 | [mtgglobals.com](https://mtgglobals.com/) | 320 | INACCESIBIL | 1 | 2 | 131 | 2 | DNS/TLS/conexiune/blocaj client |
| 229 | [shalltry.com](https://shalltry.com/) | 321 | INACCESIBIL | 1 | 1 | 115 | 2 | DNS/TLS/conexiune/blocaj client |
| 230 | [heytapmobile.com](https://heytapmobile.com/) | 322 | INACCESIBIL | 1 | 2 | 135 | 2 | DNS/TLS/conexiune/blocaj client |
| 231 | [salesforce.com](https://salesforce.com/) | 323 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 232 | [samsungqbe.com](https://samsungqbe.com/) | 324 | INACCESIBIL | 1 | 2 | 131 | 2 | DNS/TLS/conexiune/blocaj client |
| 233 | [oxylabs.io](https://oxylabs.io/) | 325 | FUNCȚIONEAZĂ | 1 | 25 | 16384 | 11 | OK; limite controlate |
| 234 | [myshopify.com](https://myshopify.com/) | 327 | INACCESIBIL | 1 | 1 | 116 | 2 | DNS/TLS/conexiune/blocaj client |
| 235 | [googleblog.com](https://googleblog.com/) | 328 | FUNCȚIONEAZĂ | 1 | 55 | 4455 | 1 | OK; limite controlate |
| 236 | [aliyun.com](https://aliyun.com/) | 330 | FUNCȚIONEAZĂ | 1 | 11 | 16384 | 4 | OK; limite controlate |
| 237 | [gnu.org](https://gnu.org/) | 331 | FUNCȚIONEAZĂ | 1 | 113 | 3405 | 13 | OK; limite controlate |
| 238 | [name.com](https://name.com/) | 333 | FUNCȚIONEAZĂ | 1 | 0 | 7651 | 0 | OK; limite controlate |
| 239 | [yandexcloud.net](https://yandexcloud.net/) | 334 | INACCESIBIL | 1 | 2 | 133 | 2 | DNS/TLS/conexiune/blocaj client |
| 240 | [smartadserver.com](https://smartadserver.com/) | 335 | FUNCȚIONEAZĂ | 1 | 90 | 8449 | 39 | OK; limite controlate |
| 241 | [worldnic.com](https://worldnic.com/) | 336 | PARȚIAL | 1 | 4 | 589 | 2 | Timeout repetat la navigare |
| 242 | [un.org](https://un.org/) | 337 | FUNCȚIONEAZĂ | 1 | 18 | 482 | 6 | OK |
| 243 | [crashlytics.com](https://crashlytics.com/) | 338 | INACCESIBIL | 1 | 25 | 16384 | 11 | Politică browser sau redirect autentificare |
| 244 | [bilibili.com](https://bilibili.com/) | 339 | FUNCȚIONEAZĂ | 1 | 71 | 912 | 30 | OK; limite controlate |
| 245 | [cdc.gov](https://cdc.gov/) | 341 | FUNCȚIONEAZĂ | 1 | 82 | 3628 | 13 | OK; limite controlate |
| 246 | [inner-active.mobi](https://inner-active.mobi/) | 342 | PARȚIAL | 1 | 4 | 599 | 2 | Timeout repetat la navigare |
| 247 | [trustpilot.com](https://trustpilot.com/) | 344 | FUNCȚIONEAZĂ | 1 | 48 | 16384 | 22 | OK; limite controlate |
| 248 | [naver.com](https://naver.com/) | 345 | FUNCȚIONEAZĂ | 1 | 0 | 619 | 0 | OK |
| 249 | [weebly.com](https://weebly.com/) | 346 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 250 | [tbcache.com](https://tbcache.com/) | 347 | PARȚIAL | 1 | 4 | 587 | 2 | Timeout repetat la navigare |
| 251 | [checkpoint.com](https://checkpoint.com/) | 348 | FUNCȚIONEAZĂ | 1 | 115 | 3359 | 3 | OK; limite controlate |
| 252 | [trueconf.net](https://trueconf.net/) | 349 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 253 | [issuu.com](https://issuu.com/) | 350 | INACCESIBIL | 1 | 25 | 16384 | 11 | Politică browser sau redirect autentificare |
| 254 | [allawnos.com](https://allawnos.com/) | 352 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 255 | [wsj.com](https://wsj.com/) | 354 | FUNCȚIONEAZĂ | 1 | 0 | 16383 | 0 | OK; limite controlate |
| 256 | [media.net](https://media.net/) | 355 | FUNCȚIONEAZĂ | 1 | 16 | 1834 | 29 | OK; limite controlate |
| 257 | [tradingview.com](https://tradingview.com/) | 356 | FUNCȚIONEAZĂ | 1 | 2 | 16384 | 1 | OK; limite controlate |
| 258 | [ioref.io](https://ioref.io/) | 357 | INACCESIBIL | 1 | 2 | 119 | 2 | DNS/TLS/conexiune/blocaj client |
| 259 | [washingtonpost.com](https://washingtonpost.com/) | 358 | FUNCȚIONEAZĂ | 1 | 36 | 5659 | 3 | OK; limite controlate |
| 260 | [google.cn](https://google.cn/) | 359 | FUNCȚIONEAZĂ | 1 | 2 | 41 | 1 | OK |
| 261 | [stanford.edu](https://stanford.edu/) | 361 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 262 | [indeed.com](https://indeed.com/) | 362 | FUNCȚIONEAZĂ | 1 | 26 | 900 | 1 | OK; limite controlate |
| 263 | [att.com](https://att.com/) | 363 | FUNCȚIONEAZĂ | 1 | 52 | 1036 | 1 | OK; limite controlate |
| 264 | [nvidia.com](https://nvidia.com/) | 364 | FUNCȚIONEAZĂ | 1 | 12 | 16384 | 1 | OK; limite controlate |
| 265 | [calendly.com](https://calendly.com/) | 366 | FUNCȚIONEAZĂ | 1 | 68 | 5390 | 3 | OK; limite controlate |
| 266 | [awswaf.com](https://awswaf.com/) | 367 | INACCESIBIL | 1 | 2 | 123 | 2 | DNS/TLS/conexiune/blocaj client |
| 267 | [cookiedatabase.org](https://cookiedatabase.org/) | 368 | FUNCȚIONEAZĂ | 1 | 57 | 4456 | 4 | OK; limite controlate |
| 268 | [bluehost.com](https://bluehost.com/) | 369 | FUNCȚIONEAZĂ | 1 | 34 | 16383 | 5 | OK; limite controlate |
| 269 | [samsungcloudsolution.com](https://samsungcloudsolution.com/) | 370 | INACCESIBIL | 1 | 2 | 151 | 2 | DNS/TLS/conexiune/blocaj client |
| 270 | [quickconnect.to](https://quickconnect.to/) | 371 | FUNCȚIONEAZĂ | 1 | 5 | 1531 | 10 | OK |
| 271 | [zendesk.com](https://zendesk.com/) | 372 | FUNCȚIONEAZĂ | 1 | 26 | 14623 | 0 | OK; limite controlate |
| 272 | [ip-api.com](https://ip-api.com/) | 373 | FUNCȚIONEAZĂ | 1 | 20 | 1505 | 3 | OK |
| 273 | [plesk.com](https://plesk.com/) | 374 | FUNCȚIONEAZĂ | 1 | 56 | 16384 | 0 | OK; limite controlate |
| 274 | [namecheap.com](https://namecheap.com/) | 375 | FUNCȚIONEAZĂ | 1 | 119 | 8194 | 4 | OK; limite controlate |
| 275 | [dotaplabs.net](https://dotaplabs.net/) | 376 | INACCESIBIL | 1 | 2 | 129 | 2 | DNS/TLS/conexiune/blocaj client |
| 276 | [selectel.ru](https://selectel.ru/) | 377 | FUNCȚIONEAZĂ | 1 | 16 | 8964 | 0 | OK; limite controlate |
| 277 | [amazon.de](https://amazon.de/) | 378 | FUNCȚIONEAZĂ | 1 | 3 | 170 | 0 | OK |
| 278 | [mynetname.net](https://mynetname.net/) | 380 | INACCESIBIL | 1 | 2 | 129 | 2 | DNS/TLS/conexiune/blocaj client |
| 279 | [gitlab.com](https://gitlab.com/) | 381 | FUNCȚIONEAZĂ | 1 | 35 | 92 | 0 | OK; limite controlate |
| 280 | [mi.com](https://mi.com/) | 382 | FUNCȚIONEAZĂ | 1 | 15 | 6596 | 19 | OK; limite controlate |
| 281 | [tiktokv.us](https://tiktokv.us/) | 383 | INACCESIBIL | 1 | 2 | 123 | 2 | DNS/TLS/conexiune/blocaj client |
| 282 | [ezvizlife.com](https://ezvizlife.com/) | 385 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 283 | [dell.com](https://dell.com/) | 386 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 284 | [geobasket.ru](https://geobasket.ru/) | 387 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 285 | [tp-link.com](https://tp-link.com/) | 389 | FUNCȚIONEAZĂ | 1 | 92 | 1288 | 4 | OK; limite controlate |
| 286 | [amazontrust.com](https://amazontrust.com/) | 390 | FUNCȚIONEAZĂ | 1 | 4 | 103 | 1 | OK |
| 287 | [onelink.me](https://onelink.me/) | 391 | FUNCȚIONEAZĂ | 1 | 101 | 7356 | 6 | OK; limite controlate |
| 288 | [bsky.app](https://bsky.app/) | 392 | FUNCȚIONEAZĂ | 1 | 48 | 8516 | 9 | OK; limite controlate |
| 289 | [yandex.com](https://yandex.com/) | 393 | FUNCȚIONEAZĂ | 1 | 25 | 88 | 0 | OK |
| 290 | [spaceweb.pro](https://spaceweb.pro/) | 394 | PARȚIAL | 1 | 4 | 589 | 2 | Timeout repetat la navigare |
| 291 | [ailawandorder.com](https://ailawandorder.com/) | 395 | PARȚIAL | 1 | 4 | 599 | 2 | Timeout repetat la navigare |
| 292 | [ibyteimg.com](https://ibyteimg.com/) | 397 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 293 | [kwai-pro.com](https://kwai-pro.com/) | 399 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 294 | [vivoglobal.com](https://vivoglobal.com/) | 401 | FUNCȚIONEAZĂ | 1 | 5 | 38 | 5 | OK |
| 295 | [163.com](https://163.com/) | 402 | INACCESIBIL | 1 | 92 | 1288 | 4 | Politică browser sau redirect autentificare |
| 296 | [aliexpress.com](https://aliexpress.com/) | 403 | INACCESIBIL | 1 | 4 | 103 | 1 | Politică browser sau redirect autentificare |
| 297 | [unsplash.com](https://unsplash.com/) | 405 | FUNCȚIONEAZĂ | 1 | 46 | 945 | 7 | OK; limite controlate |
| 298 | [ipify.org](https://ipify.org/) | 406 | FUNCȚIONEAZĂ | 1 | 9 | 8565 | 3 | OK; limite controlate |
| 299 | [netangels.ru](https://netangels.ru/) | 407 | FUNCȚIONEAZĂ | 1 | 25 | 16384 | 22 | OK; limite controlate |
| 300 | [heytapdl.com](https://heytapdl.com/) | 410 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 301 | [globo.com](https://globo.com/) | 412 | FUNCȚIONEAZĂ | 1 | 58 | 16384 | 15 | OK; limite controlate |
| 302 | [line.me](https://line.me/) | 413 | FUNCȚIONEAZĂ | 1 | 35 | 8682 | 43 | OK; limite controlate |
| 303 | [tiktokv.eu](https://tiktokv.eu/) | 414 | INACCESIBIL | 1 | 2 | 123 | 2 | DNS/TLS/conexiune/blocaj client |
| 304 | [dropcatch.com](https://dropcatch.com/) | 415 | FUNCȚIONEAZĂ | 1 | 34 | 2687 | 1 | OK; limite controlate |
| 305 | [huawei.com](https://huawei.com/) | 417 | FUNCȚIONEAZĂ | 1 | 83 | 4850 | 7 | OK; limite controlate |
| 306 | [beian.gov.cn](https://beian.gov.cn/) | 418 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 307 | [amazonalexa.com](https://amazonalexa.com/) | 419 | FUNCȚIONEAZĂ | 1 | 41 | 16384 | 2 | OK; limite controlate |
| 308 | [brave.com](https://brave.com/) | 422 | FUNCȚIONEAZĂ | 1 | 47 | 2455 | 4 | OK; limite controlate |
| 309 | [kaspersky-labs.com](https://kaspersky-labs.com/) | 423 | INACCESIBIL | 1 | 3 | 563 | 2 | DNS/TLS/conexiune/blocaj client |
| 310 | [steamcommunity.com](https://steamcommunity.com/) | 424 | FUNCȚIONEAZĂ | 1 | 103 | 6058 | 12 | OK; limite controlate |
| 311 | [libp2p.direct](https://libp2p.direct/) | 425 | INACCESIBIL | 1 | 2 | 129 | 2 | DNS/TLS/conexiune/blocaj client |
| 312 | [temu.com](https://temu.com/) | 426 | FUNCȚIONEAZĂ | 1 | 8 | 16051 | 1 | OK; limite controlate |
| 313 | [pangle.io](https://pangle.io/) | 427 | INACCESIBIL | 1 | 2 | 121 | 2 | DNS/TLS/conexiune/blocaj client |
| 314 | [online-metrix.net](https://online-metrix.net/) | 428 | INACCESIBIL | 1 | 2 | 137 | 2 | DNS/TLS/conexiune/blocaj client |
| 315 | [taobao.com](https://taobao.com/) | 430 | INACCESIBIL | 1 | 83 | 4850 | 7 | Politică browser sau redirect autentificare |
| 316 | [expireddomains.com](https://expireddomains.com/) | 431 | FUNCȚIONEAZĂ | 1 | 15 | 4804 | 2 | OK; limite controlate |
| 317 | [espn.com](https://espn.com/) | 432 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 318 | [shiabank.com](https://shiabank.com/) | 433 | INACCESIBIL | 1 | 34 | 2687 | 1 | Politică browser sau redirect autentificare |
| 319 | [kwaipros.com](https://kwaipros.com/) | 435 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 320 | [paloaltonetworks.com](https://paloaltonetworks.com/) | 436 | FUNCȚIONEAZĂ | 1 | 99 | 16384 | 15 | OK; limite controlate |
| 321 | [businessinsider.com](https://businessinsider.com/) | 437 | FUNCȚIONEAZĂ | 1 | 85 | 9640 | 0 | OK; limite controlate |
| 322 | [claude.ai](https://claude.ai/) | 438 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 323 | [substack.com](https://substack.com/) | 439 | FUNCȚIONEAZĂ | 1 | 40 | 1653 | 7 | OK; limite controlate |
| 324 | [avsxappcaptiveportal.com](https://avsxappcaptiveportal.com/) | 440 | PARȚIAL | 1 | 4 | 613 | 2 | Timeout repetat la navigare |
| 325 | [goodreads.com](https://goodreads.com/) | 441 | FUNCȚIONEAZĂ | 1 | 71 | 67 | 34 | OK; limite controlate |
| 326 | [xboxlive.com](https://xboxlive.com/) | 442 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 327 | [intel.com](https://intel.com/) | 444 | FUNCȚIONEAZĂ | 1 | 72 | 6743 | 0 | OK; limite controlate |
| 328 | [wp.com](https://wp.com/) | 445 | FUNCȚIONEAZĂ | 1 | 78 | 3194 | 0 | OK; limite controlate |
| 329 | [ipinfo.io](https://ipinfo.io/) | 446 | FUNCȚIONEAZĂ | 1 | 46 | 6783 | 3 | OK; limite controlate |
| 330 | [chinamobile.com](https://chinamobile.com/) | 447 | PARȚIAL | 1 | 4 | 595 | 2 | Timeout repetat la navigare |
| 331 | [g.page](https://g.page/) | 448 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 332 | [pixabay.com](https://pixabay.com/) | 449 | FUNCȚIONEAZĂ | 1 | 74 | 5123 | 2 | OK; limite controlate |
| 333 | [vkuser.net](https://vkuser.net/) | 450 | INACCESIBIL | 1 | 40 | 1653 | 7 | Politică browser sau redirect autentificare |
| 334 | [yahoo.co.jp](https://yahoo.co.jp/) | 451 | FUNCȚIONEAZĂ | 1 | 20 | 1304 | 1 | OK |
| 335 | [sohu.com](https://sohu.com/) | 452 | FUNCȚIONEAZĂ | 1 | 106 | 5534 | 17 | OK; limite controlate |
| 336 | [wbx2.com](https://wbx2.com/) | 454 | PARȚIAL | 1 | 4 | 581 | 2 | Timeout repetat la navigare |
| 337 | [sina.com.cn](https://sina.com.cn/) | 455 | FUNCȚIONEAZĂ | 1 | 83 | 16384 | 1 | OK; limite controlate |
| 338 | [go.com](https://go.com/) | 456 | FUNCȚIONEAZĂ | 1 | 45 | 8581 | 2 | OK; limite controlate |
| 339 | [speedtest.net](https://speedtest.net/) | 457 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 340 | [netease.com](https://netease.com/) | 458 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 341 | [awsglobalaccelerator.com](https://awsglobalaccelerator.com/) | 459 | INACCESIBIL | 1 | 2 | 151 | 2 | DNS/TLS/conexiune/blocaj client |
| 342 | [skyhigh.cloud](https://skyhigh.cloud/) | 460 | FUNCȚIONEAZĂ | 1 | 23 | 16384 | 7 | OK; limite controlate |
| 343 | [list-manage.com](https://list-manage.com/) | 461 | PARȚIAL | 1 | 4 | 595 | 2 | Timeout repetat la navigare |
| 344 | [featureassets.org](https://featureassets.org/) | 462 | INACCESIBIL | 1 | 1 | 120 | 2 | DNS/TLS/conexiune/blocaj client |
| 345 | [cnbc.com](https://cnbc.com/) | 463 | FUNCȚIONEAZĂ | 1 | 74 | 16384 | 1 | OK; limite controlate |
| 346 | [byteglb.com](https://byteglb.com/) | 464 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 347 | [mikrotik.com](https://mikrotik.com/) | 465 | FUNCȚIONEAZĂ | 1 | 110 | 9174 | 0 | OK; limite controlate |
| 348 | [gamepass.com](https://gamepass.com/) | 466 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 349 | [eye4.cn](https://eye4.cn/) | 467 | INACCESIBIL | 1 | 45 | 8581 | 2 | Politică browser sau redirect autentificare |
| 350 | [timeweb.ru](https://timeweb.ru/) | 468 | FUNCȚIONEAZĂ | 1 | 39 | 5902 | 10 | OK; limite controlate |
| 351 | [statista.com](https://statista.com/) | 469 | FUNCȚIONEAZĂ | 1 | 0 | 16384 | 0 | OK; limite controlate |
| 352 | [ietf.org](https://ietf.org/) | 471 | FUNCȚIONEAZĂ | 1 | 119 | 1683 | 5 | OK; limite controlate |
| 353 | [firetvcaptiveportal.com](https://firetvcaptiveportal.com/) | 472 | PARȚIAL | 1 | 4 | 611 | 2 | Timeout repetat la navigare |
| 354 | [kwai.net](https://kwai.net/) | 473 | PARȚIAL | 1 | 4 | 581 | 2 | Timeout repetat la navigare |
| 355 | [xcal.tv](https://xcal.tv/) | 474 | INACCESIBIL | 1 | 2 | 117 | 2 | DNS/TLS/conexiune/blocaj client |
| 356 | [myqcloud.com](https://myqcloud.com/) | 476 | INACCESIBIL | 1 | 2 | 141 | 2 | DNS/TLS/conexiune/blocaj client |
| 357 | [adobe.net](https://adobe.net/) | 478 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 358 | [adriver.ru](https://adriver.ru/) | 479 | FUNCȚIONEAZĂ | 1 | 32 | 882 | 9 | OK |
| 359 | [addtoany.com](https://addtoany.com/) | 481 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 360 | [duolingo.com](https://duolingo.com/) | 482 | FUNCȚIONEAZĂ | 1 | 2 | 2219 | 2 | OK; limite controlate |
| 361 | [ivi.ru](https://ivi.ru/) | 485 | FUNCȚIONEAZĂ | 1 | 22 | 7692 | 38 | OK; limite controlate |
| 362 | [quora.com](https://quora.com/) | 487 | FUNCȚIONEAZĂ | 1 | 59 | 10874 | 1 | OK; limite controlate |
| 363 | [nease.net](https://nease.net/) | 488 | PARȚIAL | 1 | 4 | 583 | 2 | Timeout repetat la navigare |
| 364 | [sc-gw.com](https://sc-gw.com/) | 489 | INACCESIBIL | 1 | 2 | 121 | 2 | DNS/TLS/conexiune/blocaj client |
| 365 | [supercell.com](https://supercell.com/) | 491 | FUNCȚIONEAZĂ | 1 | 60 | 2051 | 32 | OK; limite controlate |
| 366 | [scribd.com](https://scribd.com/) | 493 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 367 | [mysql.com](https://mysql.com/) | 494 | FUNCȚIONEAZĂ | 1 | 109 | 2747 | 2 | OK; limite controlate |
| 368 | [eventbrite.com](https://eventbrite.com/) | 495 | FUNCȚIONEAZĂ | 1 | 32 | 7037 | 1 | OK; limite controlate |
| 369 | [tencent-cloud.net](https://tencent-cloud.net/) | 496 | INACCESIBIL | 1 | 2 | 151 | 2 | DNS/TLS/conexiune/blocaj client |
| 370 | [markmonitor.com](https://markmonitor.com/) | 497 | FUNCȚIONEAZĂ | 1 | 11 | 9286 | 2 | OK; limite controlate |
| 371 | [amazon.co.jp](https://amazon.co.jp/) | 498 | FUNCȚIONEAZĂ | 1 | 41 | 16384 | 2 | OK; limite controlate |
| 372 | [myhuaweicloud.com](https://myhuaweicloud.com/) | 499 | INACCESIBIL | 1 | 2 | 137 | 2 | DNS/TLS/conexiune/blocaj client |
| 373 | [shopifysvc.com](https://shopifysvc.com/) | 500 | INACCESIBIL | 1 | 2 | 131 | 2 | DNS/TLS/conexiune/blocaj client |
| 374 | [atlassian.net](https://atlassian.net/) | 501 | FUNCȚIONEAZĂ | 1 | 23 | 15020 | 0 | OK; limite controlate |
| 375 | [aol.com](https://aol.com/) | 503 | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după 4,5 s |
| 376 | [shein.com](https://shein.com/) | 506 | FUNCȚIONEAZĂ | 1 | 0 | 5702 | 0 | OK; limite controlate |
| 377 | [ampproject.org](https://ampproject.org/) | 507 | FUNCȚIONEAZĂ | 1 | 37 | 1692 | 0 | OK; limite controlate |
| 378 | [behance.net](https://behance.net/) | 508 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 379 | [mediatek.com](https://mediatek.com/) | 509 | FUNCȚIONEAZĂ | 1 | 118 | 8638 | 1 | OK; limite controlate |
| 380 | [exp-tas.com](https://exp-tas.com/) | 510 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 381 | [mcafee.com](https://mcafee.com/) | 511 | FUNCȚIONEAZĂ | 1 | 40 | 14573 | 2 | OK; limite controlate |
| 382 | [amzn.to](https://amzn.to/) | 512 | FUNCȚIONEAZĂ | 1 | 36 | 16384 | 6 | OK; limite controlate |
| 383 | [google.de](https://google.de/) | 513 | FUNCȚIONEAZĂ | 1 | 10 | 5549 | 7 | OK; limite controlate |
| 384 | [foxnews.com](https://foxnews.com/) | 514 | FUNCȚIONEAZĂ | 1 | 78 | 16384 | 2 | OK; limite controlate |
| 385 | [indiatimes.com](https://indiatimes.com/) | 515 | FUNCȚIONEAZĂ | 1 | 57 | 5806 | 46 | OK; limite controlate |
| 386 | [google.com.hk](https://google.com.hk/) | 517 | FUNCȚIONEAZĂ | 1 | 11 | 2188 | 8 | OK; limite controlate |
| 387 | [blogger.com](https://blogger.com/) | 518 | FUNCȚIONEAZĂ | 1 | 17 | 1208 | 42 | OK |
| 388 | [ft.com](https://ft.com/) | 519 | FUNCȚIONEAZĂ | 1 | 8 | 926 | 0 | OK |
| 389 | [gosuslugi.ru](https://gosuslugi.ru/) | 520 | INACCESIBIL | 1 | 78 | 16384 | 2 | Politică browser sau redirect autentificare |
| 390 | [run.app](https://run.app/) | 522 | FUNCȚIONEAZĂ | 1 | 1 | 43 | 0 | OK |
| 391 | [dynatrace.com](https://dynatrace.com/) | 523 | FUNCȚIONEAZĂ | 1 | 23 | 10133 | 0 | OK; limite controlate |
| 392 | [fandom.com](https://fandom.com/) | 524 | FUNCȚIONEAZĂ | 1 | 0 | 16383 | 0 | OK; limite controlate |
| 393 | [adobedtm.com](https://adobedtm.com/) | 525 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 394 | [ipv4only.arpa](https://ipv4only.arpa/) | 526 | PARȚIAL | 1 | 4 | 591 | 2 | Timeout repetat la navigare |
| 395 | [firefox.com](https://firefox.com/) | 527 | FUNCȚIONEAZĂ | 1 | 61 | 6768 | 11 | OK; limite controlate |
| 396 | [slideshare.net](https://slideshare.net/) | 528 | FUNCȚIONEAZĂ | 1 | 79 | 3679 | 9 | OK; limite controlate |
| 397 | [okta.com](https://okta.com/) | 529 | FUNCȚIONEAZĂ | 1 | 80 | 16384 | 14 | OK; limite controlate |
| 398 | [visualstudio.com](https://visualstudio.com/) | 531 | FUNCȚIONEAZĂ | 1 | 94 | 3046 | 2 | OK; limite controlate |
| 399 | [ngenix.net](https://ngenix.net/) | 532 | FUNCȚIONEAZĂ | 1 | 4 | 420 | 0 | OK |
| 400 | [amazon.co.za](https://amazon.co.za/) | 533 | FUNCȚIONEAZĂ | 1 | 27 | 16384 | 3 | OK; limite controlate |
| 401 | [discord.media](https://discord.media/) | 534 | FUNCȚIONEAZĂ | 1 | 6 | 938 | 0 | OK |
| 402 | [squarespace.com](https://squarespace.com/) | 535 | FUNCȚIONEAZĂ | 1 | 58 | 12224 | 11 | OK; limite controlate |
| 403 | [trendmicro.com](https://trendmicro.com/) | 536 | FUNCȚIONEAZĂ | 1 | 56 | 6107 | 2 | OK; limite controlate |
| 404 | [wired.com](https://wired.com/) | 537 | FUNCȚIONEAZĂ | 1 | 31 | 10368 | 0 | OK; limite controlate |
| 405 | [capcut.com](https://capcut.com/) | 538 | FUNCȚIONEAZĂ | 1 | 54 | 3749 | 24 | OK; limite controlate |
| 406 | [jquery.com](https://jquery.com/) | 539 | FUNCȚIONEAZĂ | 1 | 70 | 2147 | 3 | OK |
| 407 | [patreon.com](https://patreon.com/) | 540 | FUNCȚIONEAZĂ | 1 | 74 | 7859 | 6 | OK; limite controlate |
| 408 | [oup.com](https://oup.com/) | 542 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 409 | [sberbank.ru](https://sberbank.ru/) | 543 | INACCESIBIL | 1 | 31 | 10368 | 0 | Politică browser sau redirect autentificare |
| 410 | [svc.ms](https://svc.ms/) | 544 | INACCESIBIL | 1 | 2 | 115 | 2 | DNS/TLS/conexiune/blocaj client |
| 411 | [elasticbeanstalk.com](https://elasticbeanstalk.com/) | 545 | INACCESIBIL | 1 | 4 | 611 | 2 | DNS/TLS/conexiune/blocaj client |
| 412 | [hicloud.com](https://hicloud.com/) | 546 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 413 | [tplinkcloud.com](https://tplinkcloud.com/) | 547 | FUNCȚIONEAZĂ | 1 | 25 | 3710 | 15 | OK |
| 414 | [fast.com](https://fast.com/) | 548 | FUNCȚIONEAZĂ | 1 | 46 | 2469 | 0 | OK |
| 415 | [supertms.com](https://supertms.com/) | 549 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 416 | [noaa.gov](https://noaa.gov/) | 550 | FUNCȚIONEAZĂ | 1 | 52 | 579 | 9 | OK; limite controlate |
| 417 | [tandfonline.com](https://tandfonline.com/) | 551 | FUNCȚIONEAZĂ | 1 | 80 | 5910 | 1 | OK; limite controlate |
| 418 | [live.net](https://live.net/) | 552 | INACCESIBIL | 1 | 2 | 119 | 2 | DNS/TLS/conexiune/blocaj client |
| 419 | [time.com](https://time.com/) | 553 | FUNCȚIONEAZĂ | 1 | 24 | 11727 | 3 | OK; limite controlate |
| 420 | [palmplaystore.com](https://palmplaystore.com/) | 554 | FUNCȚIONEAZĂ | 1 | 5 | 3929 | 47 | OK; limite controlate |
| 421 | [vidaahub.com](https://vidaahub.com/) | 556 | INACCESIBIL | 1 | 2 | 127 | 2 | DNS/TLS/conexiune/blocaj client |
| 422 | [cornell.edu](https://cornell.edu/) | 557 | FUNCȚIONEAZĂ | 1 | 112 | 4687 | 6 | OK; limite controlate |
| 423 | [on.aws](https://on.aws/) | 558 | INACCESIBIL | 1 | 2 | 115 | 2 | DNS/TLS/conexiune/blocaj client |
| 424 | [share.google](https://share.google/) | 559 | FUNCȚIONEAZĂ | 1 | 3 | 284 | 1 | OK |
| 425 | [usatoday.com](https://usatoday.com/) | 560 | FUNCȚIONEAZĂ | 1 | 22 | 9840 | 5 | OK; limite controlate |
| 426 | [beyondwickedmapping.org](https://beyondwickedmapping.org/) | 561 | INACCESIBIL | 1 | 1 | 126 | 2 | DNS/TLS/conexiune/blocaj client |
| 427 | [deviantart.com](https://deviantart.com/) | 562 | FUNCȚIONEAZĂ | 1 | 42 | 2632 | 1 | OK; limite controlate |
| 428 | [vkontakte.ru](https://vkontakte.ru/) | 563 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 429 | [360yield.com](https://360yield.com/) | 564 | FUNCȚIONEAZĂ | 1 | 9 | 60 | 4 | OK |
| 430 | [2gis.com](https://2gis.com/) | 565 | FUNCȚIONEAZĂ | 1 | 32 | 1273 | 6 | OK; limite controlate |
| 431 | [e2ro.com](https://e2ro.com/) | 566 | INACCESIBIL | 1 | 2 | 119 | 2 | DNS/TLS/conexiune/blocaj client |
| 432 | [eset.com](https://eset.com/) | 568 | FUNCȚIONEAZĂ | 1 | 26 | 16384 | 0 | OK; limite controlate |
| 433 | [dreamhost.com](https://dreamhost.com/) | 569 | FUNCȚIONEAZĂ | 1 | 34 | 16383 | 2 | OK; limite controlate |
| 434 | [nstld.com](https://nstld.com/) | 570 | INACCESIBIL | 1 | 2 | 121 | 2 | DNS/TLS/conexiune/blocaj client |
| 435 | [aboutads.info](https://aboutads.info/) | 572 | FUNCȚIONEAZĂ | 1 | 37 | 1416 | 8 | OK |
| 436 | [uol.com.br](https://uol.com.br/) | 573 | FUNCȚIONEAZĂ | 1 | 45 | 15468 | 4 | OK; limite controlate |
| 437 | [rakuten.co.jp](https://rakuten.co.jp/) | 574 | FUNCȚIONEAZĂ | 1 | 95 | 10391 | 9 | OK; limite controlate |
| 438 | [grammarly.com](https://grammarly.com/) | 575 | FUNCȚIONEAZĂ | 1 | 54 | 6029 | 4 | OK; limite controlate |
| 439 | [teamviewer.com](https://teamviewer.com/) | 576 | FUNCȚIONEAZĂ | 1 | 7 | 12472 | 0 | OK; limite controlate |
| 440 | [oraclecloud.com](https://oraclecloud.com/) | 578 | FUNCȚIONEAZĂ | 1 | 38 | 8217 | 6 | OK; limite controlate |
| 441 | [berkeley.edu](https://berkeley.edu/) | 579 | FUNCȚIONEAZĂ | 1 | 85 | 2877 | 10 | OK; limite controlate |
| 442 | [adobedc.net](https://adobedc.net/) | 582 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 443 | [target.com](https://target.com/) | 583 | FUNCȚIONEAZĂ | 1 | 34 | 12613 | 2 | OK; limite controlate |
| 444 | [3lift.com](https://3lift.com/) | 585 | FUNCȚIONEAZĂ | 1 | 51 | 12381 | 37 | OK; limite controlate |
| 445 | [t-mobile.com](https://t-mobile.com/) | 587 | FUNCȚIONEAZĂ | 1 | 70 | 15180 | 2 | OK; limite controlate |
| 446 | [ca.gov](https://ca.gov/) | 588 | FUNCȚIONEAZĂ | 1 | 65 | 1318 | 10 | OK |
| 447 | [ieee.org](https://ieee.org/) | 589 | FUNCȚIONEAZĂ | 1 | 54 | 6515 | 1 | OK; limite controlate |
| 448 | [shopee.com.br](https://shopee.com.br/) | 590 | FUNCȚIONEAZĂ | 1 | 11 | 432 | 5 | OK |
| 449 | [telegraph.co.uk](https://telegraph.co.uk/) | 591 | FUNCȚIONEAZĂ | 1 | 33 | 69 | 7 | OK; limite controlate |
| 450 | [my.com](https://my.com/) | 592 | INACCESIBIL | 1 | 2 | 115 | 2 | DNS/TLS/conexiune/blocaj client |
| 451 | [pushy.io](https://pushy.io/) | 593 | FUNCȚIONEAZĂ | 1 | 68 | 4331 | 63 | OK; limite controlate |
| 452 | [xiaomi.net](https://xiaomi.net/) | 594 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 453 | [digitalocean.com](https://digitalocean.com/) | 595 | FUNCȚIONEAZĂ | 1 | 21 | 7290 | 0 | OK; limite controlate |
| 454 | [twc.com](https://twc.com/) | 596 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 455 | [playstation.com](https://playstation.com/) | 597 | FUNCȚIONEAZĂ | 1 | 54 | 16383 | 2 | OK; limite controlate |
| 456 | [easebar.com](https://easebar.com/) | 598 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 457 | [avito.ru](https://avito.ru/) | 599 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 458 | [samsungapps.com](https://samsungapps.com/) | 601 | PARȚIAL | 1 | 4 | 595 | 2 | Timeout repetat la navigare |
| 459 | [imgsmail.ru](https://imgsmail.ru/) | 602 | INACCESIBIL | 0 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 460 | [wix.com](https://wix.com/) | 603 | FUNCȚIONEAZĂ | 1 | 35 | 13829 | 18 | OK; limite controlate |
| 461 | [klaviyo.com](https://klaviyo.com/) | 604 | FUNCȚIONEAZĂ | 1 | 37 | 9029 | 3 | OK; limite controlate |
| 462 | [mdpi.com](https://mdpi.com/) | 605 | FUNCȚIONEAZĂ | 1 | 87 | 16384 | 2 | OK; limite controlate |
| 463 | [force.com](https://force.com/) | 606 | FUNCȚIONEAZĂ | 1 | 70 | 16384 | 10 | OK; limite controlate |
| 464 | [threads.com](https://threads.com/) | 607 | FUNCȚIONEAZĂ | 1 | 18 | 2511 | 2 | OK; limite controlate |
| 465 | [amazon.fr](https://amazon.fr/) | 608 | FUNCȚIONEAZĂ | 1 | 39 | 16384 | 2 | OK; limite controlate |
| 466 | [translate.goog](https://translate.goog/) | 610 | FUNCȚIONEAZĂ | 1 | 1 | 43 | 0 | OK |
| 467 | [loc.gov](https://loc.gov/) | 611 | PARȚIAL | 1 | 3 | 273 | 1 | Challenge/blocaj de conținut |
| 468 | [atlassian.com](https://atlassian.com/) | 612 | FUNCȚIONEAZĂ | 1 | 24 | 14559 | 6 | OK; limite controlate |
| 469 | [nintendo.com](https://nintendo.com/) | 614 | FUNCȚIONEAZĂ | 1 | 14 | 12519 | 1 | OK; limite controlate |
| 470 | [webempresa.eu](https://webempresa.eu/) | 615 | FUNCȚIONEAZĂ | 1 | 28 | 16384 | 20 | OK; limite controlate |
| 471 | [onetrust.com](https://onetrust.com/) | 616 | FUNCȚIONEAZĂ | 1 | 80 | 16384 | 2 | OK; limite controlate |
| 472 | [unesco.org](https://unesco.org/) | 617 | FUNCȚIONEAZĂ | 1 | 1 | 22 | 0 | OK |
| 473 | [jotform.com](https://jotform.com/) | 618 | FUNCȚIONEAZĂ | 1 | 50 | 4566 | 37 | OK; limite controlate |
| 474 | [surveymonkey.com](https://surveymonkey.com/) | 620 | FUNCȚIONEAZĂ | 1 | 59 | 4250 | 0 | OK; limite controlate |
| 475 | [msidentity.com](https://msidentity.com/) | 621 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 476 | [sharethrough.com](https://sharethrough.com/) | 622 | FUNCȚIONEAZĂ | 1 | 90 | 5308 | 9 | OK; limite controlate |
| 477 | [uk.com](https://uk.com/) | 625 | FUNCȚIONEAZĂ | 1 | 50 | 5625 | 50 | OK; limite controlate |
| 478 | [free.fr](https://free.fr/) | 627 | FUNCȚIONEAZĂ | 1 | 65 | 12634 | 4 | OK; limite controlate |
| 479 | [sagepub.com](https://sagepub.com/) | 628 | FUNCȚIONEAZĂ | 1 | 103 | 8469 | 1 | OK; limite controlate |
| 480 | [withgoogle.com](https://withgoogle.com/) | 630 | FUNCȚIONEAZĂ | 1 | 10 | 5549 | 7 | OK; limite controlate |
| 481 | [googlezip.net](https://googlezip.net/) | 632 | INACCESIBIL | 1 | 2 | 129 | 2 | DNS/TLS/conexiune/blocaj client |
| 482 | [bidswitch.net](https://bidswitch.net/) | 633 | INACCESIBIL | 1 | 2 | 129 | 2 | DNS/TLS/conexiune/blocaj client |
| 483 | [amazon.ca](https://amazon.ca/) | 634 | FUNCȚIONEAZĂ | 1 | 39 | 16384 | 2 | OK; limite controlate |
| 484 | [ovh.net](https://ovh.net/) | 635 | FUNCȚIONEAZĂ | 1 | 15 | 142 | 1 | OK |
| 485 | [tencent.com](https://tencent.com/) | 636 | INACCESIBIL | 1 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 486 | [techcrunch.com](https://techcrunch.com/) | 638 | FUNCȚIONEAZĂ | 1 | 69 | 10725 | 6 | OK; limite controlate |
| 487 | [mhverifier.ru](https://mhverifier.ru/) | 639 | INACCESIBIL | 0 | 0 | 0 | 0 | DNS/TLS/conexiune/blocaj client |
| 488 | [googletagservices.com](https://googletagservices.com/) | 641 | INACCESIBIL | 1 | 2 | 145 | 2 | DNS/TLS/conexiune/blocaj client |
| 489 | [360.cn](https://360.cn/) | 642 | FUNCȚIONEAZĂ | 1 | 111 | 3843 | 83 | OK; limite controlate |
| 490 | [britannica.com](https://britannica.com/) | 643 | INACCESIBIL | 1 | 0 | 0 | 0 | Politică browser sau redirect autentificare |
| 491 | [hostgator.com.br](https://hostgator.com.br/) | 644 | FUNCȚIONEAZĂ | 1 | 23 | 2178 | 8 | OK; limite controlate |
| 492 | [yelp.com](https://yelp.com/) | 645 | FUNCȚIONEAZĂ | 1 | 23 | 8131 | 2 | OK; limite controlate |
| 493 | [dailymail.co.uk](https://dailymail.co.uk/) | 646 | FUNCȚIONEAZĂ | 1 | 50 | 16384 | 26 | OK; limite controlate |
| 494 | [ups.com](https://ups.com/) | 647 | FUNCȚIONEAZĂ | 1 | 100 | 7558 | 5 | OK; limite controlate |
| 495 | [vedsalb.com](https://vedsalb.com/) | 648 | INACCESIBIL | 1 | 2 | 125 | 2 | DNS/TLS/conexiune/blocaj client |
| 496 | [redhat.com](https://redhat.com/) | 649 | FUNCȚIONEAZĂ | 1 | 45 | 5160 | 0 | OK; limite controlate |
| 497 | [shop.app](https://shop.app/) | 652 | FUNCȚIONEAZĂ | 1 | 38 | 4109 | 13 | OK; limite controlate |
| 498 | [elpais.com](https://elpais.com/) | 654 | FUNCȚIONEAZĂ | 1 | 62 | 16383 | 24 | OK; limite controlate |
| 499 | [imgur.com](https://imgur.com/) | 655 | FUNCȚIONEAZĂ | 1 | 1 | 111 | 0 | OK |
| 500 | [nike.com](https://nike.com/) | 656 | FUNCȚIONEAZĂ | 1 | 2 | 7700 | 0 | OK; limite controlate |
