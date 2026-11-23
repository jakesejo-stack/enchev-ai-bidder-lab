# Портфейл: Вход и Изход на парите (Revolut Sandbox)

Следва указанията на Митко от 23.11.2026: **само Revolut Sandbox**, реални пари само след негово изрично одобрение. ENCHEV **не пази паричен баланс** — портфейлът показва движенията, потвърдени от Revolut (read-only ledger).

| | Какво | Кой |
| --- | --- | --- |
| **Вход** | Депозит = задържане по картата (manual capture, pre-authorisation, до 29 дни). Сумата е по правило на сървъра. | Купувачът минава през hosted checkout на Revolut |
| **Изход — освобождаване** | Загубилият или отменен търг → задържането се отменя, парите остават при купувача | Сървърът на търга / оператор |
| **Изход — санкция** | Победителят се отказа или не плати → взима се санкцията (≤ задържаното) | Сървърът на търга / оператор |
| **Изход — връщане** | Взета сума се връща по картата | Оператор |
| **Плащане към продавача** | Изключено (501) до KYB, договор, проверени средства, правен преглед и одобрение | — |

## Endpoints (Vercel)

- `GET /api/wallet/status` — средата, свързан ли е, правилото за депозита.
- `POST /api/wallet/deposit` `{bidder, lotId, maxBid}` → поръчка в Revolut, връща `checkoutUrl`.
- `GET /api/wallet/ledger?bidder=…` — движенията от Revolut (само за четене).
- `POST /api/wallet/settle` `{orderId, action: release|forfeit|refund, amount?}` — само с `Authorization: Bearer ENCHEV_OPS_TOKEN`.
- `POST /api/wallet/webhook` — проверка на подписа (HMAC-SHA256 върху `v1.{timestamp}.{raw body}`, 5 мин.), после поръчката се чете отново от Revolut.
- `POST /api/wallet/payout` — 501 (виж горе).

## Настройка (Борко, Vercel → Environment Variables, Preview)

1. `REVOLUT_ENV=sandbox`, `REVOLUT_SECRET_KEY=sk_…` (Sandbox ключ от Revolut Business Sandbox → Merchant API).
2. Webhook в Sandbox: `POST https://sandbox-merchant.revolut.com/api/1.0/webhooks` с `url=https://<preview>/api/wallet/webhook` и събития `ORDER_AUTHORISED`, `ORDER_COMPLETED`, `ORDER_CANCELLED`, `ORDER_PAYMENT_DECLINED`, `ORDER_PAYMENT_FAILED`; полученият `signing_secret` → `REVOLUT_WEBHOOK_SECRET`.
3. `ENCHEV_OPS_TOKEN` — дълъг случаен низ, само за оператора.
4. По желание за теста на Митко с 0,01 €: `DEPOSIT_FIXED_CENTS=1`. Иначе `DEPOSIT_RATE=0.1`, `DEPOSIT_MIN_CENTS=30000`.
5. Реални пари: `REVOLUT_ENV=production` работи **само** ако собственикът зададе и `ENCHEV_REAL_MONEY=approved`. Без това сървърът отказва.

## Тест с два профила (Sandbox)

Два браузъра = два профила. И двамата правят „Вход“ с тестова карта на Revolut Sandbox → в „Движения“ е „Задържан (вход)“. След търга операторът: загубилият → „Освободи“; победителят → плаща или „Санкция“. Записват се order ID и състоянията от Revolut.

## Ограничения в лабораторията

- Профилът е случаен идентификатор на устройството; в ENCHEV това е влезлият потребител (Supabase).
- Няма база: движенията се четат от Revolut, а webhook-ът пише одит ред във Vercel логовете. В ENCHEV същият handler записва payment record с уникален `provider_reference` (PR #659).
- ДЕМО търговете тук не ползват портфейла; реален търг с депозит е само на сървъра на ENCHEV.
