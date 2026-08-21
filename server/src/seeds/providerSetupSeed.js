import { query, withTx } from '../db.js';

const PROVIDERS = [
  {
    id: 'apichp',
    name: 'apichp',
    apiUrl: 'https://cheapestsmmpanels.com/api/v2',
    secretName: 'APICHP_API_KEY',
  },
  {
    id: 'apigoup',
    name: 'apigoup',
    apiUrl: 'https://goupsocial.com/api/v2',
    secretName: 'APIGOUP_API_KEY',
  },
  {
    id: 'Gop',
    name: 'Gop',
    apiUrl: 'https://goupsocial.com/api/v2',
    secretName: 'APIGOUP_API_KEY',
  },
];

const ACCOUNTS = [
  {
    id: 'b52c56fe-97f8-403c-a2c9-817244005711',
    providerId: 'apichp',
    name: 'apichp',
    apiUrl: 'https://cheapestsmmpanels.com/api/v2',
    secretName: 'APICHP_API_KEY',
    priority: 1,
  },
  {
    id: '7cf9511f-cbdc-4717-8f5d-98fd61f65684',
    providerId: 'apigoup',
    name: 'apigoup',
    apiUrl: 'https://goupsocial.com/api/v2',
    secretName: 'APIGOUP_API_KEY',
    priority: 1,
  },
];

const MAPPINGS = [
  ['8c2ca34c-a92f-4247-9154-6ae18be774c8', '12b44c55-e021-4363-bc6f-09b2477506a3', 'b52c56fe-97f8-403c-a2c9-817244005711', '1348'],
  ['3aab8ae6-8efe-473f-91b7-4d27f3977c6b', '2f44d5ee-7cc3-4724-944a-029a1c1f0d93', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '4633'],
  ['24a20726-6756-4aa1-a6be-9bb5c10d1c7d', '313d243c-511f-4c5a-96ac-9473423b158c', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '5291'],
  ['5a52aae4-56f5-40c0-a5e5-27cfc40484ba', '41f9e9a0-0364-4eab-8b6c-5714521a8d49', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '2760'],
  ['bb40ad0b-8fbb-479c-b24d-1473a349ee9a', '565831ab-4071-48f8-a3e3-646c45b25a5a', 'b52c56fe-97f8-403c-a2c9-817244005711', '2903'],
  ['65b549d4-3229-4ab1-bc5f-eb40b792bc97', '7954c7b3-1bc7-4d47-96f7-7854ec365732', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '4710'],
  ['ef435390-8cdf-4cda-bdd8-160871a04c9c', '7cbd0bf2-5f16-437c-bb73-51c9f619e70e', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '4710'],
  ['dbd8188f-858c-4c80-9394-7f659bf4e177', '89735002-3ac1-431b-b9fa-3f2c7c37233c', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '4633'],
  ['d0664e7b-db36-424a-b489-fee630695a2e', 'bbac445b-89de-43fb-b727-72164a97cd6d', 'b52c56fe-97f8-403c-a2c9-817244005711', '1899'],
  ['999208ee-ca84-4a09-a7bf-280ba5f5dbf7', 'c7eb1aa3-c840-419d-9509-71ed346317eb', 'b52c56fe-97f8-403c-a2c9-817244005711', '4688'],
  ['67cff1df-184f-4869-861f-99b9064de7ff', 'd222747b-710e-4df6-bcff-cd1c2bdad75c', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '2760'],
  ['27950a6a-ea6c-49a6-bc35-b37ae651a35a', 'e541a345-90b6-4f0c-9d3e-0a86cd4ad462', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '5291'],
  ['245c64f6-33b0-48cd-9e19-d971e6e3bd42', 'f252ac46-2c6e-4982-8777-9baf44ba3f4a', '7cf9511f-cbdc-4717-8f5d-98fd61f65684', '5031'],
];

function readSecret(name) {
  return String(process.env[name] || '').trim();
}

export async function seedProviderConfiguration() {
  const keys = {
    APICHP_API_KEY: readSecret('APICHP_API_KEY'),
    APIGOUP_API_KEY: readSecret('APIGOUP_API_KEY'),
  };

  const missing = Object.entries(keys).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    const { rows: [existing] } = await query(
      `SELECT COUNT(*)::int AS cnt
         FROM provider_accounts
        WHERE id = ANY($1::uuid[])
          AND is_active = true`,
      [ACCOUNTS.map(account => account.id)]
    );
    if (Number(existing?.cnt || 0) < ACCOUNTS.length) {
      console.warn(`[seed] provider setup waiting for Replit Secrets: ${missing.join(', ')}`);
    }
    return { configured: false, missing };
  }

  await withTx(async (client) => {
    for (const provider of PROVIDERS) {
      const apiKey = keys[provider.secretName];
      await client.query(
        `INSERT INTO providers (id, name, api_url, api_key, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               api_url = EXCLUDED.api_url,
               api_key = EXCLUDED.api_key,
               is_active = true,
               updated_at = now()`,
        [provider.id, provider.name, provider.apiUrl, apiKey]
      );
    }

    for (const account of ACCOUNTS) {
      const apiKey = keys[account.secretName];
      await client.query(
        `INSERT INTO provider_accounts
           (id, provider_id, name, api_key, api_url, priority, is_active, delivery_multiplier)
         VALUES ($1, $2, $3, $4, $5, $6, true, 1)
         ON CONFLICT (id) DO UPDATE
           SET provider_id = EXCLUDED.provider_id,
               name = EXCLUDED.name,
               api_key = EXCLUDED.api_key,
               api_url = EXCLUDED.api_url,
               priority = EXCLUDED.priority,
               is_active = true,
               updated_at = now()`,
        [account.id, account.providerId, account.name, apiKey, account.apiUrl, account.priority]
      );
    }

    for (const [id, serviceId, accountId, providerServiceId] of MAPPINGS) {
      await client.query(
        `INSERT INTO service_provider_mapping
           (id, service_id, provider_account_id, provider_service_id, sort_order, is_active)
         VALUES ($1, $2, $3, $4, 1, true)
         ON CONFLICT (id) DO UPDATE
           SET service_id = EXCLUDED.service_id,
               provider_account_id = EXCLUDED.provider_account_id,
               provider_service_id = EXCLUDED.provider_service_id,
               sort_order = EXCLUDED.sort_order,
               is_active = true`,
        [id, serviceId, accountId, providerServiceId]
      );
    }
  });

  console.log(`[seed] provider setup ready: ${ACCOUNTS.length} accounts, ${MAPPINGS.length} service mappings`);
  return { configured: true, missing: [] };
}