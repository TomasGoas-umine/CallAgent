#!/usr/bin/env node
/**
 * Entry point de CDK — NO se ejecuto `cdk deploy` ni `cdk synth` contra una cuenta AWS real en
 * esta sesion (regla no negociable del prompt §1.6). Este archivo deja el stack listo para la
 * siguiente sesion de despliegue.
 */
import { App } from 'aws-cdk-lib';
import { UmineVoiceStack } from '../lib/stacks/umine-voice-stack.js';

const app = new App();

new UmineVoiceStack(app, 'UmineVoiceStack', {
  env: {
    // Se toman de las variables de entorno estandar de CDK — nunca hardcodear una cuenta/region.
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
