// Real mode is OFF in this lab. It can only be enabled by configuring an authorised Enchev
// Auctions endpoint at build time (no keys in the browser). Nothing here is set today.
export interface AppConfig {
  realMode: { enabled: false; reason: string } | { enabled: true; streamUrl: string; apiBase: string };
}

export const CONFIG: AppConfig = {
  realMode: {
    enabled: false,
    reason: 'Реалното наддаване е изключено, докато не бъде изрично одобрено и свързано с оторизиран бекенд на Enchev Auctions. Реалните данни се показват само за четене в „Реални данни“.',
  },
};
