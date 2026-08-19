#!/usr/bin/env node
import "dotenv/config";
import { fetchProviderBalances } from "../src/services/providerBalances.js";

const items = await fetchProviderBalances();
console.log(JSON.stringify({ items }, null, 2));
