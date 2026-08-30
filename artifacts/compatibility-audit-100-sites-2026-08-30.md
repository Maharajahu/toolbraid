# ToolBraid — audit real pe 100 de site-uri

Data: 30 august 2026
Browser: Google Chrome normal, extensia ToolBraid instalată
Mod: read-only; fără clickuri, formulare, autentificări sau mutații externe

## Verdict

- 89 / 100 funcționează pentru discovery + extracție + snapshot canonic + tool de citire.
- 9 / 100 sunt parțiale: motorul răspunde fail-safe, dar pagina publică livrează un DOM fără conținut util chiar și după retestarea la 4,5 secunde.
- 2 / 100 nu au putut fi testate deoarece navigarea a fost blocată de Chrome/politica browserului.
- 87 dintre cele 89 pagini funcționale au expus și acțiuni candidate cu approval obligatoriu.
- Numai-citire în această stare publică: YouTube, Dropbox.
- 78 pagini funcționale au expus media în inventarul DOM.
- Total descriptori generați pe paginile funcționale: 3978.

Parțiale: Notion, CNN, Reuters, Bloomberg, NPR, AP News, Al Jazeera, Bing, Microsoft.
Blocate: Drupal, The New York Times.

## Metodă

Pentru fiecare domeniu s-a deschis pagina publică reală în Chrome și s-a rulat exact extractorul de producție `extension/page-extractor.js`. Fingerprintul furnizat de pagină, statisticile și inventarul media au fost eliminate conform `boundedSnapshot()`; apoi s-au folosit exact `createPageSnapshot()` și `generateWebMcpToolDescriptors()` din motorul ToolBraid. Un rezultat este „funcționează” numai dacă există fingerprint canonic, minimum un descriptor read și conținut DOM util. Toate shell-urile goale au fost retestate după 4,5 secunde.

„Limite controlate aplicate” înseamnă că extractorul a atins unul dintre plafoanele intenționate de securitate/dimensiune; aceasta este o protecție, nu un eșec.

Acest audit validează compatibilitatea live de citire/discovery pe 100 de domenii. Nu pretinde că toate acțiunile mutate au fost executate: ele au fost doar descoperite, iar ToolBraid le păstrează în spatele approval-ului.

## Rezultate complete

| # | Site | Verdict | Read | Acțiuni | Text | Media | Observație |
|---:|---|---|---:|---:|---:|---:|---|
| 1 | [Example](https://example.com/) | FUNCȚIONEAZĂ | 1 | 1 | 127 | 0 | OK |
| 2 | [Wikipedia](https://en.wikipedia.org/wiki/World_Wide_Web) | FUNCȚIONEAZĂ | 1 | 62 | 16384 | 3 | OK; limite controlate aplicate |
| 3 | [GitHub](https://github.com/openai/openai-python) | FUNCȚIONEAZĂ | 1 | 13 | 16384 | 0 | OK; limite controlate aplicate |
| 4 | [Vercel](https://vercel.com/) | FUNCȚIONEAZĂ | 1 | 49 | 557 | 1 | OK; limite controlate aplicate |
| 5 | [X](https://x.com/thsottiaux/status/2093515916076343774) | FUNCȚIONEAZĂ | 1 | 21 | 3020 | 3 | OK; limite controlate aplicate |
| 6 | [YouTube](https://www.youtube.com/) | FUNCȚIONEAZĂ | 1 | 0 | 4000 | 1 | OK; limite controlate aplicate |
| 7 | [TikTok](https://www.tiktok.com/) | FUNCȚIONEAZĂ | 1 | 25 | 469 | 2 | OK; limite controlate aplicate |
| 8 | [Reddit](https://www.reddit.com/r/programming/) | FUNCȚIONEAZĂ | 1 | 7 | 238 | 1 | OK |
| 9 | [Stack Overflow](https://stackoverflow.com/) | FUNCȚIONEAZĂ | 1 | 93 | 10810 | 1 | OK; limite controlate aplicate |
| 10 | [Hacker News](https://news.ycombinator.com/) | FUNCȚIONEAZĂ | 1 | 105 | 3539 | 1 | OK; limite controlate aplicate |
| 11 | [MDN](https://developer.mozilla.org/) | FUNCȚIONEAZĂ | 1 | 96 | 6826 | 1 | OK; limite controlate aplicate |
| 12 | [W3C](https://www.w3.org/) | FUNCȚIONEAZĂ | 1 | 104 | 1442 | 15 | OK; limite controlate aplicate |
| 13 | [Node.js](https://nodejs.org/) | FUNCȚIONEAZĂ | 1 | 16 | 2502 | 0 | OK; limite controlate aplicate |
| 14 | [Python](https://www.python.org/) | FUNCȚIONEAZĂ | 1 | 119 | 4703 | 1 | OK; limite controlate aplicate |
| 15 | [Rust](https://www.rust-lang.org/) | FUNCȚIONEAZĂ | 1 | 37 | 2452 | 9 | OK |
| 16 | [Go](https://go.dev/) | FUNCȚIONEAZĂ | 1 | 86 | 3410 | 38 | OK; limite controlate aplicate |
| 17 | [PHP](https://www.php.net/) | FUNCȚIONEAZĂ | 1 | 119 | 228 | 3 | OK; limite controlate aplicate |
| 18 | [Ruby](https://www.ruby-lang.org/) | FUNCȚIONEAZĂ | 1 | 43 | 3838 | 39 | OK; limite controlate aplicate |
| 19 | [Kotlin](https://kotlinlang.org/) | FUNCȚIONEAZĂ | 1 | 72 | 6130 | 10 | OK; limite controlate aplicate |
| 20 | [Swift](https://www.swift.org/) | FUNCȚIONEAZĂ | 1 | 23 | 4634 | 0 | OK; limite controlate aplicate |
| 21 | [React](https://react.dev/) | FUNCȚIONEAZĂ | 1 | 17 | 5293 | 2 | OK; limite controlate aplicate |
| 22 | [Vue](https://vuejs.org/) | FUNCȚIONEAZĂ | 1 | 79 | 1074 | 0 | OK; limite controlate aplicate |
| 23 | [Angular](https://angular.dev/) | FUNCȚIONEAZĂ | 1 | 31 | 1605 | 1 | OK; limite controlate aplicate |
| 24 | [Svelte](https://svelte.dev/) | FUNCȚIONEAZĂ | 1 | 119 | 1514 | 22 | OK; limite controlate aplicate |
| 25 | [Next.js](https://nextjs.org/) | FUNCȚIONEAZĂ | 1 | 42 | 4385 | 10 | OK; limite controlate aplicate |
| 26 | [Astro](https://astro.build/) | FUNCȚIONEAZĂ | 1 | 45 | 5096 | 1 | OK; limite controlate aplicate |
| 27 | [Tailwind CSS](https://tailwindcss.com/) | FUNCȚIONEAZĂ | 1 | 15 | 6915 | 1 | OK; limite controlate aplicate |
| 28 | [npm](https://www.npmjs.com/) | FUNCȚIONEAZĂ | 1 | 29 | 881 | 1 | OK |
| 29 | [PyPI](https://pypi.org/) | FUNCȚIONEAZĂ | 1 | 61 | 351 | 16 | OK |
| 30 | [crates.io](https://crates.io/) | FUNCȚIONEAZĂ | 1 | 38 | 4465 | 1 | OK; limite controlate aplicate |
| 31 | [Docker](https://www.docker.com/) | FUNCȚIONEAZĂ | 1 | 30 | 3224 | 1 | OK; limite controlate aplicate |
| 32 | [Kubernetes](https://kubernetes.io/) | FUNCȚIONEAZĂ | 1 | 79 | 1505 | 9 | OK; limite controlate aplicate |
| 33 | [Cloudflare](https://www.cloudflare.com/) | FUNCȚIONEAZĂ | 1 | 18 | 4976 | 2 | OK; limite controlate aplicate |
| 34 | [AWS](https://aws.amazon.com/) | FUNCȚIONEAZĂ | 1 | 10 | 7636 | 0 | OK; limite controlate aplicate |
| 35 | [Microsoft Azure](https://azure.microsoft.com/) | FUNCȚIONEAZĂ | 1 | 102 | 11793 | 1 | OK; limite controlate aplicate |
| 36 | [Google Cloud](https://cloud.google.com/) | FUNCȚIONEAZĂ | 1 | 41 | 16384 | 26 | OK; limite controlate aplicate |
| 37 | [Stripe](https://stripe.com/) | FUNCȚIONEAZĂ | 1 | 15 | 10451 | 1 | OK; limite controlate aplicate |
| 38 | [PayPal](https://www.paypal.com/) | FUNCȚIONEAZĂ | 1 | 41 | 4115 | 1 | OK; limite controlate aplicate |
| 39 | [Shopify](https://www.shopify.com/) | FUNCȚIONEAZĂ | 1 | 32 | 2177 | 17 | OK; limite controlate aplicate |
| 40 | [WordPress](https://wordpress.org/) | FUNCȚIONEAZĂ | 1 | 35 | 2185 | 2 | OK; limite controlate aplicate |
| 41 | [Drupal](https://www.drupal.org/) | NU MERGE | 1 | 1 | 117 | 2 | Navigare blocată de Chrome: ERR_BLOCKED_BY_CLIENT |
| 42 | [Webflow](https://webflow.com/) | FUNCȚIONEAZĂ | 1 | 55 | 16384 | 7 | OK; limite controlate aplicate |
| 43 | [Figma](https://www.figma.com/) | FUNCȚIONEAZĂ | 1 | 43 | 2517 | 2 | OK; limite controlate aplicate |
| 44 | [Canva](https://www.canva.com/) | FUNCȚIONEAZĂ | 1 | 5 | 134 | 1 | OK |
| 45 | [Notion](https://www.notion.so/product) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 46 | [Slack](https://slack.com/) | FUNCȚIONEAZĂ | 1 | 62 | 12894 | 39 | OK; limite controlate aplicate |
| 47 | [Discord](https://discord.com/) | FUNCȚIONEAZĂ | 1 | 67 | 8476 | 23 | OK; limite controlate aplicate |
| 48 | [Zoom](https://zoom.us/) | FUNCȚIONEAZĂ | 1 | 106 | 7787 | 11 | OK; limite controlate aplicate |
| 49 | [Dropbox](https://www.dropbox.com/) | FUNCȚIONEAZĂ | 1 | 0 | 754 | 0 | OK; limite controlate aplicate |
| 50 | [Box](https://www.box.com/) | FUNCȚIONEAZĂ | 1 | 38 | 5676 | 21 | OK; limite controlate aplicate |
| 51 | [OpenAI](https://openai.com/) | FUNCȚIONEAZĂ | 1 | 26 | 3622 | 4 | OK; limite controlate aplicate |
| 52 | [Anthropic](https://www.anthropic.com/) | FUNCȚIONEAZĂ | 1 | 51 | 16384 | 0 | OK; limite controlate aplicate |
| 53 | [Google DeepMind](https://deepmind.google/) | FUNCȚIONEAZĂ | 1 | 24 | 5636 | 20 | OK; limite controlate aplicate |
| 54 | [Hugging Face](https://huggingface.co/) | FUNCȚIONEAZĂ | 1 | 42 | 3477 | 6 | OK; limite controlate aplicate |
| 55 | [Perplexity](https://www.perplexity.ai/) | FUNCȚIONEAZĂ | 1 | 20 | 276 | 0 | OK; limite controlate aplicate |
| 56 | [Mistral AI](https://mistral.ai/) | FUNCȚIONEAZĂ | 1 | 29 | 8627 | 6 | OK; limite controlate aplicate |
| 57 | [Cohere](https://cohere.com/) | FUNCȚIONEAZĂ | 1 | 45 | 6631 | 3 | OK; limite controlate aplicate |
| 58 | [Ollama](https://ollama.com/) | FUNCȚIONEAZĂ | 1 | 43 | 1543 | 53 | OK |
| 59 | [arXiv](https://arxiv.org/) | FUNCȚIONEAZĂ | 1 | 119 | 4982 | 1 | OK; limite controlate aplicate |
| 60 | [Nature](https://www.nature.com/) | FUNCȚIONEAZĂ | 1 | 66 | 216 | 6 | OK; limite controlate aplicate |
| 61 | [Science](https://www.science.org/) | FUNCȚIONEAZĂ | 1 | 62 | 9681 | 10 | OK; limite controlate aplicate |
| 62 | [BBC](https://www.bbc.com/) | FUNCȚIONEAZĂ | 1 | 38 | 11538 | 2 | OK; limite controlate aplicate |
| 63 | [CNN](https://www.cnn.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 64 | [Reuters](https://www.reuters.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 65 | [The Guardian](https://www.theguardian.com/) | FUNCȚIONEAZĂ | 1 | 11 | 1027 | 2 | OK |
| 66 | [The New York Times](https://www.nytimes.com/) | NU MERGE | 1 | 62 | 9681 | 10 | Navigare interzisă de politica browserului |
| 67 | [Bloomberg](https://www.bloomberg.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 68 | [NPR](https://www.npr.org/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 69 | [AP News](https://apnews.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 70 | [Al Jazeera](https://www.aljazeera.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 71 | [IMDb](https://www.imdb.com/) | FUNCȚIONEAZĂ | 1 | 47 | 16384 | 1 | OK; limite controlate aplicate |
| 72 | [Spotify](https://open.spotify.com/) | FUNCȚIONEAZĂ | 1 | 29 | 1452 | 2 | OK; limite controlate aplicate |
| 73 | [SoundCloud](https://soundcloud.com/) | FUNCȚIONEAZĂ | 1 | 36 | 13006 | 1 | OK; limite controlate aplicate |
| 74 | [Twitch](https://www.twitch.tv/) | FUNCȚIONEAZĂ | 1 | 25 | 975 | 11 | OK; limite controlate aplicate |
| 75 | [Vimeo](https://vimeo.com/) | FUNCȚIONEAZĂ | 1 | 31 | 6697 | 26 | OK; limite controlate aplicate |
| 76 | [Dailymotion](https://www.dailymotion.com/) | FUNCȚIONEAZĂ | 1 | 44 | 3640 | 15 | OK; limite controlate aplicate |
| 77 | [Pinterest](https://www.pinterest.com/) | FUNCȚIONEAZĂ | 1 | 15 | 1899 | 3 | OK; limite controlate aplicate |
| 78 | [Instagram](https://www.instagram.com/) | FUNCȚIONEAZĂ | 1 | 7 | 549 | 2 | OK; limite controlate aplicate |
| 79 | [Facebook](https://www.facebook.com/) | FUNCȚIONEAZĂ | 1 | 33 | 1344 | 0 | OK; limite controlate aplicate |
| 80 | [LinkedIn](https://www.linkedin.com/) | FUNCȚIONEAZĂ | 1 | 68 | 3601 | 1 | OK; limite controlate aplicate |
| 81 | [eBay](https://www.ebay.com/) | FUNCȚIONEAZĂ | 1 | 58 | 271 | 25 | OK; limite controlate aplicate |
| 82 | [Etsy](https://www.etsy.com/) | FUNCȚIONEAZĂ | 1 | 27 | 0 | 9 | OK; limite controlate aplicate |
| 83 | [Amazon UK](https://www.amazon.co.uk/) | FUNCȚIONEAZĂ | 1 | 38 | 16384 | 1 | OK; limite controlate aplicate |
| 84 | [Walmart](https://www.walmart.com/) | FUNCȚIONEAZĂ | 1 | 4 | 4816 | 2 | OK; limite controlate aplicate |
| 85 | [IKEA](https://www.ikea.com/) | FUNCȚIONEAZĂ | 1 | 24 | 1248 | 9 | OK; limite controlate aplicate |
| 86 | [Booking.com](https://www.booking.com/) | FUNCȚIONEAZĂ | 1 | 11 | 7957 | 1 | OK; limite controlate aplicate |
| 87 | [Airbnb](https://www.airbnb.com/) | FUNCȚIONEAZĂ | 1 | 8 | 2119 | 8 | OK; limite controlate aplicate |
| 88 | [Tripadvisor](https://www.tripadvisor.com/) | FUNCȚIONEAZĂ | 1 | 23 | 3826 | 8 | OK; limite controlate aplicate |
| 89 | [Expedia](https://www.expedia.com/) | FUNCȚIONEAZĂ | 1 | 31 | 4106 | 8 | OK; limite controlate aplicate |
| 90 | [GOV.UK](https://www.gov.uk/) | FUNCȚIONEAZĂ | 1 | 60 | 2758 | 1 | OK; limite controlate aplicate |
| 91 | [NHS](https://www.nhs.uk/) | FUNCȚIONEAZĂ | 1 | 55 | 1725 | 0 | OK |
| 92 | [European Union](https://european-union.europa.eu/) | FUNCȚIONEAZĂ | 1 | 71 | 2402 | 2 | OK; limite controlate aplicate |
| 93 | [NASA](https://www.nasa.gov/) | FUNCȚIONEAZĂ | 1 | 53 | 4250 | 4 | OK; limite controlate aplicate |
| 94 | [The Weather Channel](https://weather.com/) | FUNCȚIONEAZĂ | 1 | 27 | 2739 | 10 | OK; limite controlate aplicate |
| 95 | [AccuWeather](https://www.accuweather.com/) | FUNCȚIONEAZĂ | 1 | 46 | 5892 | 2 | OK; limite controlate aplicate |
| 96 | [DuckDuckGo](https://duckduckgo.com/) | FUNCȚIONEAZĂ | 1 | 26 | 5166 | 19 | OK; limite controlate aplicate |
| 97 | [Bing](https://www.bing.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
| 98 | [Google](https://www.google.com/) | FUNCȚIONEAZĂ | 1 | 10 | 5549 | 7 | OK; limite controlate aplicate |
| 99 | [Apple](https://www.apple.com/) | FUNCȚIONEAZĂ | 1 | 60 | 5528 | 4 | OK; limite controlate aplicate |
| 100 | [Microsoft](https://www.microsoft.com/) | PARȚIAL | 1 | 0 | 0 | 0 | DOM fără conținut util după retest 4,5 s |
