import { BadRequestException } from '@nestjs/common';

/**
 * Validação mínima de um JSON Schema de parâmetros:
 * { type: "object", properties: { ... }, required?: string[] }
 */
export function validateParamsSchema(schema: unknown): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new BadRequestException('paramsSchema deve ser um objeto JSON');
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== 'object') {
    throw new BadRequestException('paramsSchema.type deve ser "object"');
  }
  if (
    typeof s.properties !== 'object' ||
    s.properties === null ||
    Array.isArray(s.properties)
  ) {
    throw new BadRequestException('paramsSchema.properties deve ser um objeto');
  }
  if (s.required !== undefined) {
    if (
      !Array.isArray(s.required) ||
      s.required.some((r) => typeof r !== 'string')
    ) {
      throw new BadRequestException(
        'paramsSchema.required deve ser uma lista de strings',
      );
    }
    const props = Object.keys(s.properties);
    const missing = (s.required as string[]).filter((r) => !props.includes(r));
    if (missing.length) {
      throw new BadRequestException(
        `paramsSchema.required referencia propriedades inexistentes: ${missing.join(', ')}`,
      );
    }
  }
}
