import {Validator} from "./Validator";
import {ValidationError} from "./ValidationError";
import {ValidationMetadata} from "../metadata/ValidationMetadata";
import {MetadataStorage} from "../metadata/MetadataStorage";
import {getFromContainer} from "../index";
import {ValidatorOptions} from "./ValidatorOptions";
import {ValidationTypes} from "./ValidationTypes";

/**
 * Executes validation over given object.
 */
export class ValidationExecutor {

    // -------------------------------------------------------------------------
    // Properties
    // -------------------------------------------------------------------------

    private errors: ValidationError[] = [];
    private awaitingPromises: Promise<any>[] = [];

    // -------------------------------------------------------------------------
    // Private Properties
    // -------------------------------------------------------------------------

    private metadataStorage = getFromContainer(MetadataStorage);
    
    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(private validator: Validator, 
                private validatorOptions?: ValidatorOptions) {
    }
    
    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------
    
    execute(object: Object) {
        const groups = this.validatorOptions ? this.validatorOptions.groups : undefined;
        const targetMetadatas = this.metadataStorage.getTargetValidationMetadatas(object.constructor, groups);
        const groupedMetadatas = this.metadataStorage.groupByPropertyName(targetMetadatas);

        Object.keys(groupedMetadatas).forEach(propertyName => {
            const value = (object as any)[propertyName];
            const metadatas = groupedMetadatas[propertyName];
            const customValidationMetadatas = metadatas.filter(metadata => metadata.type === ValidationTypes.CUSTOM_VALIDATION);
            const nestedValidationMetadatas = metadatas.filter(metadata => metadata.type === ValidationTypes.NESTED_VALIDATION);
            const notEmptyMetadatas = metadatas.filter(metadata => metadata.type === ValidationTypes.NOT_EMPTY);
            
            // handle NOT_EMPTY validation type the special way - it should work no matter skipMissingProperties is set or not
            this.defaultValidations(value, notEmptyMetadatas);
            
            if (!value && this.validatorOptions && this.validatorOptions.skipMissingProperties === true)
                return;

            this.defaultValidations(value, metadatas);
            this.customValidations(object, value, customValidationMetadatas);
            this.nestedValidations(value, nestedValidationMetadatas);
        });

        return Promise.all(this.awaitingPromises).then(() => this.errors);
    }
    
    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    private defaultValidations(value: any, metadatas: ValidationMetadata[]) {
        return metadatas
            .filter(metadata => {
                if (metadata.each) {
                    if (value instanceof Array) {
                        return !value.every((subValue: any) => this.validator.validateBasedOnMetadata(subValue, metadata));
                        // } else {
                        //     throw new Error(`Cannot validate ${(metadata.target as any).name}#${metadata.propertyName} because supplied value is not an array, however array is expected for validation.`);
                    }

                } else {
                    return !this.validator.validateBasedOnMetadata(value, metadata);
                }
            })
            .forEach(metadata => {
                this.errors.push(this.createValidationError(value, metadata));
            });
    }

    private customValidations(object: Object, value: any, metadatas: ValidationMetadata[]) {
        metadatas.forEach(metadata => {
            this.metadataStorage
                .getTargetValidatorConstraints(metadata.value1 as Function)
                .forEach(customConstraintMetadata => {
                    const validatedValue = customConstraintMetadata.instance.validate(value, object);
                    if (validatedValue instanceof Promise) {
                        const promise = validatedValue.then(isValid => {
                            if (!isValid) {
                                this.errors.push(this.createValidationError(value, metadata));
                            }
                        });
                        this.awaitingPromises.push(promise);
                    } else {
                        if (!validatedValue)
                            this.errors.push(this.createValidationError(value, metadata));
                    }
                });
        });
    }
    
    private nestedValidations(value: any, metadatas: ValidationMetadata[]) {
        metadatas.forEach(metadata => {
            if (metadata.type !== ValidationTypes.NESTED_VALIDATION) return;

            if (value instanceof Array) {
                value.forEach((subValue: any) => this.awaitingPromises.push(this.execute(subValue)));

            } else if (value instanceof Object) {
                this.awaitingPromises.push(this.execute(value));

            } else {
                throw new Error("Only objects and arrays are supported to nested validation");
            }
        });
    }

    private createValidationError(value: any, metadata: ValidationMetadata): ValidationError {
        let message: string;
        if (metadata.message instanceof Function) {
            message = (metadata.message as ((value1?: number, value2?: number) => string))(metadata.value1, metadata.value2);
        
        } else if (typeof metadata.message === "string") {
            message = metadata.message as string;

        } else if (this.validatorOptions && !this.validatorOptions.dismissDefaultMessages) {
            // message = this.defaultMessages.getFor(metadata.type);
        }

        if (message && metadata.value1)
            message = message.replace(/\$value1/g, metadata.value1);
        if (message && metadata.value2)
            message = message.replace(/\$value2/g, metadata.value2);
        if (message && metadata.value1)
            message = message.replace(/\$value/g, metadata.value1);

        return {
            property: metadata.propertyName,
            type: metadata.type,
            message: message,
            value: value
        };
    }
    
}