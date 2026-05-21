import { IsString, Length } from 'class-validator';

export class Verify2FADto {
  @IsString()
  @Length(6, 6, { message: 'Token must be exactly 6 digits' })
  token: string;
}
