# KronEditor 1.1.2

Çalıştır, tarayıcıda **http://localhost:7171** aç. Hedef makinede Go, Node, Python, clang veya internet gerekmez — her şey paketin içinde.

| Platform | Dosya | Boyut |
|---|---|---|
| Linux x86_64 | `KronEditor-x86_64.AppImage` | 493 MB |
| Windows x64 | `KronEditor-Setup-x64.exe` | 185 MB (kurulunca 2.45 GB) |

## Yeni

- **Windows'ta yerel simülasyon.** Önceden Windows sürümü yalnızca editör + Build & Send'di. Artık Linux'takiyle aynı hot-swap runtime'ı çalışıyor: state korunarak online değişiklik, canlı değişken izleme, force/pulse yazma.
- **`build-windows.sh` artık gerçek bir installer üretiyor.** Eskiden yalnızca zip çıkarıp `.exe` adımını Windows'ta elle çalıştırmaya bırakıyordu. Şimdi NSIS ile kurulum dizini seçimi, Başlat menüsü + masaüstü kısayolu, kaldırıcı ve Programlar/Özellikler kaydı olan bir installer — tamamı Linux'ta üretiliyor.
- **Ajan sorularını tıklanabilir soruyor.** Karar gerektiğinde tek tek soruyor; cevap bir seçimse yazmak yerine düğmelere basıyorsun. Önceden sohbete numaralı liste yazıyordu ve aslında cevabı bekleyen bir şey yoktu.
- **Model listesi canlı.** Sağlayıcıdan okunuyor; sabit listeyle her sürümde eskimiyor (Claude hesabının yalnızca Opus 4.8 göstermesinin sebebi buydu). Sağlayıcılar bağlanma biçimine göre gruplandı, seçici artık her zaman tam listeyi açıyor.
- **DeepSeek eklendi.** Sağlayıcılar: Claude hesabı, Anthropic, OpenAI, Google Gemini, DeepSeek, Ollama, özel uç nokta.

## Düzeltmeler

- **armv7 BeagleBone'larda Build & Send hiç çalışmıyormuş** — statik derleme `crtbeginT.o` bulunamadı diye ölüyordu. aarch64 kartlar şans eseri çalışıyordu. (`bb_black`, `bb_black_wireless`, `bb_green`, `bb_green_wireless`, `bb_ai`)
- **HAL artık sahte başarı dönmüyor.** ADC/CAN/PWM/SPI'da `/* TODO */` gövdeler çalışan bir okumadan ayırt edilemeyecek şekilde `OK` dönüyordu; hepsi ya gerçek ya da dürüst hata. Raspberry Pi + generic Linux kartlarda ADC (IIO) ve CAN (SocketCAN) artık gerçek.
- **BeagleBone P8 pin haritası tamamen placeholder'dı** — her P8 GPIO'su sessizce başarısızdı. Gerçek AM335x hat numaraları girildi.
- Kart bilgisi düzeltmeleri: Jetson Nano artık olmayan CAN'i reklam etmiyor; Orange Pi 5 / 5 Plus / ROCK 5B gerçekten sahip oldukları CAN'i kazandı; ODROID-C4'e iki analog girişi ve altı PWM çıkışı eklendi.
- **"Ladder yaz" dediğinde ladder yazıyor.** Ajan, işin içinde aritmetik veya karşılaştırma geçince Structured Text'e kaçıyordu.
- **Structured Text'i onaylamak ladder'ı silmiyor** (ve tersi) — ikisini birlikte kullanan POU'larda.
- **Ajan durdurulabiliyor.** Stop düğmesi giriş çubuğunda, uzun sohbette ekrandan kaybolmuyor; çalışırken geçen süre görünüyor. `Esc` de durduruyor.
- Ajan panelinden Ctrl+C ile metin kopyalamak artık seçtiğin metni kopyalanmış bir POU ile değiştirmiyor.
- Ajanın ürettiği ladder blokları rungun tepesinde değil, güç hattında duruyor.
- Gemini: çok turlu araç kullanımı düzeldi; kota/kaldırılmış model hataları 800 karakterlik JSON yerine tek cümlede açıklanıyor.

## Kaldırıldı

`rpi_pico` / `rpi_pico_w` — ürünün tamamı Linux userspace varsayıyor, bu kartlara zaten deploy reddediliyordu. Geriye 30 kart kaldı, hepsi deploy edilebilir.

## Bilinen sınır

> ⚠️ **Windows simülasyonu wine64 üzerinde doğrulandı, gerçek bir Windows makinesinde henüz test edilmedi.** İlk çalıştırmayı kabul testi olarak değerlendirin. Özellikle iki şeye bakın: tarama zamanlaması ve Windows Defender / SmartScreen'in tepkisi (uygulama çalışma anında kod derleyip yüklüyor, installer imzasız).
