import { BadRequestException } from '@nestjs/common';
import { validateParamsSchema } from './params-schema.validator';

describe('validateParamsSchema', () => {
  it('aceita um schema mínimo válido', () => {
    expect(() =>
      validateParamsSchema({
        type: 'object',
        properties: { nome: { type: 'string' } },
        required: ['nome'],
      }),
    ).not.toThrow();
  });

  it('aceita schema sem required', () => {
    expect(() =>
      validateParamsSchema({ type: 'object', properties: {} }),
    ).not.toThrow();
  });

  it('rejeita valores não-objeto', () => {
    expect(() => validateParamsSchema(null)).toThrow(BadRequestException);
    expect(() => validateParamsSchema('x')).toThrow(BadRequestException);
    expect(() => validateParamsSchema([])).toThrow(BadRequestException);
  });

  it('rejeita type diferente de object', () => {
    expect(() =>
      validateParamsSchema({ type: 'string', properties: {} }),
    ).toThrow(BadRequestException);
  });

  it('rejeita properties ausente ou inválido', () => {
    expect(() => validateParamsSchema({ type: 'object' })).toThrow(
      BadRequestException,
    );
    expect(() =>
      validateParamsSchema({ type: 'object', properties: [] }),
    ).toThrow(BadRequestException);
  });

  it('rejeita required não-lista ou com propriedades inexistentes', () => {
    expect(() =>
      validateParamsSchema({
        type: 'object',
        properties: {},
        required: 'nome',
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      validateParamsSchema({
        type: 'object',
        properties: { a: {} },
        required: ['b'],
      }),
    ).toThrow(BadRequestException);
  });
});
