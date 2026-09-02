# OpenCode Go cost multipliers - 2026-09-01

## Decision

Picker labels express estimated Go quota cost per typical coding-agent request,
not a raw average of input and output token prices. OpenCode publishes a
requests-per-five-hours estimate that already combines its observed prompt,
cache, and output shapes with each model's included Go allowance. That is the
closest public measure of what selecting a model actually costs this
subscription.

The neutral baseline is MiMo V2.5 at 30,100 requests per five hours. It is the
cheapest published route that does not require training opt-in. Every
multiplier is:

```text
30,100 / model requests per five hours
```

Values are rounded to one decimal, with a trailing `.0` removed. `1x` therefore
means the cheapest published typical request without training opt-in, not zero
cost. A value below `1x` means OpenCode subsidizes that opt-in route relative to
the neutral baseline. Muse is region limited, permits Meta to use inputs and
outputs for training, and is `0.7x` under this convention.

## Sources

- Current Go documentation, model list, usage estimates, token prices, and
  endpoint families: https://opencode.ai/docs/go/
- Current Go live catalog: https://opencode.ai/zen/go/v1/models
- OpenCode model metadata and deprecated status: https://models.dev/api.json
- Last pre-deprecation Go table for GLM-5, Kimi K2.5, MiMo-V2-Pro,
  MiMo-V2-Omni, MiniMax M2.5, and Qwen3.5 Plus: OpenCode commit
  `344ccc647b93a71af7a2486f94a6458112e9250f`
- Last Go table for Hy3 Preview: OpenCode commit
  `bcbc1dba22f1524dbc2c8ade6b3f87d27a30da57`
- Last Go table for Grok 4.5: OpenCode commit
  `8615731d46153dd29b89e205fb55b2cc16205cb0`

## Multipliers

| Model ID | Requests / 5h | Cost |
| --- | ---: | ---: |
| `muse-spark-1.2-contributor` | 45,300 | 0.7x |
| `mimo-v2.5` | 30,100 | 1x |
| `longcat-2.0` | 11,400 | 2.6x |
| `qwen3.5-plus` | 10,200 | 3x |
| `deepseek-v4-flash` | 7,600 | 4x |
| `minimax-m2.5` | 6,300 | 4.8x |
| `qwen3.8-flash` | 5,400 | 5.6x |
| `qwen3.7-plus` | 4,300 | 7x |
| `hy3` | 4,300 | 7x |
| `deepseek-v4-flash-vision-exp` | 3,800 | 7.9x |
| `minimax-m2.7` | 3,400 | 8.9x |
| `qwen3.6-plus` | 3,300 | 9.1x |
| `mimo-v2.5-pro` | 3,250 | 9.3x |
| `minimax-m3` | 3,200 | 9.4x |
| `mimo-v2-omni` | 2,150 | 14x |
| `gpt-5.6-luna` | 2,050 | 14.7x |
| `hy3-preview` | 1,875 | 16.1x |
| `kimi-k2.5` | 1,850 | 16.3x |
| `glm-5.3-flash` | 1,580 | 19.1x |
| `kimi-k2.7-code` | 1,350 | 22.3x |
| `hy4-preview` | 1,350 | 22.3x |
| `mimo-v2-pro` | 1,290 | 23.3x |
| `kimi-k2.6` | 1,150 | 26.2x |
| `glm-5` | 1,150 | 26.2x |
| `deepseek-v4-pro` | 1,050 | 28.7x |
| `glm-5.2` | 880 | 34.2x |
| `glm-5.1` | 880 | 34.2x |
| `glm-5.3` | 220 | 136.8x |
| `qwen3.7-max` | 170 | 177.1x |
| `grok-4.6` | 169 | 178.1x |
| `qwen3.8-max` | 160 | 188.1x |
| `grok-4.5` | 120 | 250.8x |
| `kimi-k3` | 110 | 273.6x |

The current table supplies 25 rows. The eight routes no longer in that table
use their final official Go estimate and are marked `legacy` in the picker.
All 33 IDs still appeared in the live Go `/models` response on 2026-09-01 and
were reconfirmed there on 2026-09-02.

## Live route validation

The live `/models` response is broader than the set Console Go will actually
serve. Compatibility probes on 2026-09-02 found that three catalog-only legacy
IDs reject even a basic text request:

- `hy3-preview`: HTTP 400, `Model is unavailable`.
- `mimo-v2-omni`: HTTP 400, `Unsupported model mimo-v2-omni`.
- `mimo-v2-pro`: HTTP 400, `Unsupported model mimo-v2-pro`.

They remain checked in because the goal of this catalog is to expose all IDs
OpenCode currently advertises. Their picker labels say `legacy`; they are not
presented as working recommendations.
