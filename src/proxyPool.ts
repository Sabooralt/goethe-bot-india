import dotenv from "dotenv";

dotenv.config();

export const USE_PROXIES = process.env.USE_PROXIES === "true" || false;

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  type: "http" | "https" | "socks5";
}

class ProxyPool {
  private proxies: ProxyConfig[] = [];
  private currentIndex = 0;
  private proxyUsage = new Map<number, number>(); // Track usage count

  constructor() {
    this.loadProxiesFromEnv();
  }

  /**
   * Load proxies from environment variables
   */
  private loadProxiesFromEnv(): void {
    // Load up to 20 proxies from environment
    for (let i = 1; i <= 20; i++) {
      const host = process.env[`PROXY_${i}_HOST`];
      const port = process.env[`PROXY_${i}_PORT`];
      const username = process.env[`PROXY_${i}_USERNAME`];
      const password = process.env[`PROXY_${i}_PASSWORD`];
      const type = (process.env[`PROXY_${i}_TYPE`] || "http") as
        | "http"
        | "https"
        | "socks5";

      if (host && port) {
        this.proxies.push({
          host,
          port: parseInt(port),
          username,
          password,
          type,
        });
        this.proxyUsage.set(i - 1, 0);
        console.log(`✅ Loaded proxy ${i}: ${host}:${port}`);
      }
    }

    if (this.proxies.length === 0) {
      console.warn("⚠️ No proxies configured in environment variables");
    } else {
      console.log(`📊 Loaded ${this.proxies.length} proxies into pool`);
    }
  }

  /**
   * Get next proxy from pool (round-robin)
   */
  getNextProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null;
    }

    const proxy = this.proxies[this.currentIndex];

    // Track usage
    const usage = this.proxyUsage.get(this.currentIndex) || 0;
    this.proxyUsage.set(this.currentIndex, usage + 1);

    // Move to next proxy for next request
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

    console.log(
      `🔄 Assigned proxy ${this.currentIndex + 1}/${this.proxies.length}: ${
        proxy.host
      }:${proxy.port} (used ${usage + 1} times)`
    );

    return proxy;
  }

  /**
   * Get least used proxy (for better distribution)
   */
  getLeastUsedProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null;
    }

    let minUsage = Infinity;
    let minIndex = 0;

    // Find proxy with least usage
    for (let i = 0; i < this.proxies.length; i++) {
      const usage = this.proxyUsage.get(i) || 0;
      if (usage < minUsage) {
        minUsage = usage;
        minIndex = i;
      }
    }

    const proxy = this.proxies[minIndex];
    const usage = this.proxyUsage.get(minIndex) || 0;
    this.proxyUsage.set(minIndex, usage + 1);

    console.log(
      `⚖️ Assigned least used proxy ${minIndex + 1}: ${proxy.host}:${
        proxy.port
      } (used ${usage + 1} times)`
    );

    return proxy;
  }

  /**
   * Get random proxy from pool
   */
  getRandomProxy(): ProxyConfig | null {
    if (this.proxies.length === 0) {
      return null;
    }

    const randomIndex = Math.floor(Math.random() * this.proxies.length);
    const proxy = this.proxies[randomIndex];

    const usage = this.proxyUsage.get(randomIndex) || 0;
    this.proxyUsage.set(randomIndex, usage + 1);

    console.log(
      `🎲 Assigned random proxy ${randomIndex + 1}: ${proxy.host}:${proxy.port}`
    );

    return proxy;
  }

  /**
   * Get specific proxy by index
   */
  getProxyByIndex(index: number): ProxyConfig | null {
    if (index < 0 || index >= this.proxies.length) {
      return null;
    }

    const proxy = this.proxies[index];
    const usage = this.proxyUsage.get(index) || 0;
    this.proxyUsage.set(index, usage + 1);

    return proxy;
  }

  /**
   * Get proxy pool status
   */
  getStatus(): {
    enabled: boolean;
    totalProxies: number;
    currentIndex: number;
    usage: Array<{ index: number; proxy: string; timesUsed: number }>;
  } {
    const usage = Array.from(this.proxyUsage.entries()).map(
      ([index, count]) => ({
        index: index + 1,
        proxy: `${this.proxies[index].host}:${this.proxies[index].port}`,
        timesUsed: count,
      })
    );

    return {
      enabled: USE_PROXIES,
      totalProxies: this.proxies.length,
      currentIndex: this.currentIndex + 1,
      usage,
    };
  }

  /**
   * Reset usage counters
   */
  resetUsage(): void {
    this.proxyUsage.clear();
    for (let i = 0; i < this.proxies.length; i++) {
      this.proxyUsage.set(i, 0);
    }
    console.log("🔄 Reset proxy usage counters");
  }

  /**
   * Get total number of proxies
   */
  getProxyCount(): number {
    return this.proxies.length;
  }
}

// Singleton instance
export const proxyPool = new ProxyPool();
