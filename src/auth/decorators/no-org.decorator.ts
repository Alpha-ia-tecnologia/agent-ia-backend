import { SetMetadata } from '@nestjs/common';

export const NO_ORG_KEY = 'noOrg';

/** Rota que funciona sem organização ativa (conta, convites, criar/trocar org). */
export const NoOrg = () => SetMetadata(NO_ORG_KEY, true);
