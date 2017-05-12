import mssql from 'mssql';
import { format } from 'util';
import MSSQLSchema from './schema';
import { PostgresRecordValues, Postgres } from 'fulcrum';

const MSSQL_CONFIG = {
  database: 'fulcrumapp',
  host: 'localhost',
  port: 5432,
  max: 10,
  idleTimeoutMillis: 30000
};

export default class {
  async task(cli) {
    return cli.command({
      command: 'mssql',
      desc: 'run the MSSQL sync for a specific organization',
      builder: {
        msdatabase: {
          desc: 'mssql database name',
          type: 'string',
          default: MSSQL_CONFIG.database
        },
        mshost: {
          desc: 'mssql server host',
          type: 'string',
          default: MSSQL_CONFIG.host
        },
        msport: {
          desc: 'mssql server port',
          type: 'integer',
          default: MSSQL_CONFIG.port
        },
        msuser: {
          desc: 'mssql user',
          type: 'string'
        },
        mspassword: {
          desc: 'mssql password',
          type: 'string'
        },
        msschema: {
          desc: 'mssql schema',
          type: 'string'
        },
        org: {
          desc: 'organization name',
          required: true,
          type: 'string'
        }
      },
      handler: this.runCommand
    });
  }

  runCommand = async () => {
    await this.activate();

    const account = await fulcrum.fetchAccount(fulcrum.args.org);

    if (account) {
      const forms = await account.findActiveForms({});

      for (const form of forms) {
        await this.rebuildForm(form, account, (index) => {
          process.stdout.clearLine();
          process.stdout.cursorTo(0);
          process.stdout.write(form.name.green + ' : ' + index.toString().red + ' records');
        });

        console.log('');
      }
    } else {
      console.error('Unable to find account', fulcrum.args.org);
    }
  }

  async activate() {
    const options = {
      ...MSSQL_CONFIG,
      host: fulcrum.args.mshost || MSSQL_CONFIG.host,
      port: fulcrum.args.msport || MSSQL_CONFIG.port,
      database: fulcrum.args.msdatabase || MSSQL_CONFIG.database,
      user: fulcrum.args.msuser || MSSQL_CONFIG.user,
      password: fulcrum.args.mspassword || MSSQL_CONFIG.user
    };

    if (fulcrum.args.msuser) {
      options.user = fulcrum.args.msuser;
    }

    if (fulcrum.args.mspassword) {
      options.password = fulcrum.args.mspassword;
    }

    this.pool = await mssql.connect(config)

    // fulcrum.on('choice_list:save', this.onChoiceListSave);
    // fulcrum.on('classification_set:save', this.onClassificationSetSave);
    // fulcrum.on('project:save', this.onProjectSave);
    fulcrum.on('form:save', this.onFormSave);
    fulcrum.on('record:save', this.onRecordSave);
    fulcrum.on('record:delete', this.onRecordDelete);

    // Fetch all the existing tables on startup. This allows us to special case the
    // creation of new tables even when the form isn't version 1. If the table doesn't
    // exist, we can pretend the form is version 1 so it creates all new tables instead
    // of applying a schema diff.
    const rows = await this.run("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'");

    this.dataSchema = fulcrum.args.msschema || 'public';
    this.tableNames = rows.map(o => o.name);

    // make a client so we can use it to build SQL statements
    this.pgdb = new Postgres({});
  }

  async deactivate() {
    if (this.pool) {
      await this.pool.end();
    }
  }

  run = async (sql) => {
    sql = sql.replace(/\0/g, '');

    if (fulcrum.args.debug) {
      console.log(sql);
    }

    return await pool.request().query(sql)
  }

  log = (...args) => {
    // console.log(...args);
  }

  tableName = (account, name) => {
    return 'account_' + account.rowID + '_' + name;
  }

  onFormSave = async ({form, account, oldForm, newForm}) => {
    await this.updateForm(form, account, oldForm, newForm);
  }

  onRecordSave = async ({record, account}) => {
    await this.updateRecord(record, account);
  }

  onRecordDelete = async ({record}) => {
    const statements = PostgresRecordValues.deleteForRecordStatements(this.pgdb, record, record.form);

    await this.run(statements.map(o => o.sql).join('\n'));
  }

  onChoiceListSave = async ({object}) => {
  }

  onClassificationSetSave = async ({object}) => {
  }

  onProjectSave = async ({object}) => {
  }

  reloadTableList = async () => {
    const rows = await this.run("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'");

    this.tableNames = rows.map(o => o.name);
  }

  updateRecord = async (record, account, skipTableCheck) => {
    if (!skipTableCheck && !this.rootTableExists(record.form)) {
      await this.rebuildForm(record.form, account, () => {});
    }

    const statements = PostgresRecordValues.updateForRecordStatements(this.pgdb, record);

    await this.run(statements.map(o => o.sql).join('\n'));
  }

  rootTableExists = (form) => {
    return this.tableNames.indexOf(PostgresRecordValues.tableNameWithForm(form)) !== -1;
  }

  recreateFormTables = async (form, account) => {
    try {
      await this.updateForm(form, account, this.formVersion(form), null);
    } catch (ex) {
      if (fulcrum.args.debug) {
        console.error(sql);
      }
    }

    await this.updateForm(form, account, null, this.formVersion(form));
  }

  updateForm = async (form, account, oldForm, newForm) => {
    if (!this.rootTableExists(form) && newForm != null) {
      oldForm = null;
    }

    const {statements} = await PostgresSchema.generateSchemaStatements(account, oldForm, newForm);

    await this.dropFriendlyView(form, null);

    for (const repeatable of form.elementsOfType('Repeatable')) {
      await this.dropFriendlyView(form, repeatable);
    }

    await this.run(statements.join('\n'));

    await this.createFriendlyView(form, null);

    for (const repeatable of form.elementsOfType('Repeatable')) {
      await this.createFriendlyView(form, repeatable);
    }
  }

  async dropFriendlyView(form, repeatable) {
    const viewName = repeatable ? `${form.name} - ${repeatable.dataName}` : form.name;

    try {
      await this.run(format('DROP VIEW IF EXISTS %s.%s;', this.pgdb.ident(this.dataSchema), this.pgdb.ident(viewName)));
    } catch (ex) {
      if (fulcrum.args.debug) {
        console.error(ex);
      }
      // sometimes it doesn't exist
    }
  }

  async createFriendlyView(form, repeatable) {
    const viewName = repeatable ? `${form.name} - ${repeatable.dataName}` : form.name;

    try {
      await this.run(format('CREATE VIEW %s.%s AS SELECT * FROM %s_view_full;',
                            this.pgdb.ident(this.dataSchema),
                            this.pgdb.ident(viewName),
                            PostgresRecordValues.tableNameWithForm(form, repeatable)));
    } catch (ex) {
      if (fulcrum.args.debug) {
        console.error(ex);
      }
      // sometimes it doesn't exist
    }
  }

  async rebuildForm(form, account, progress) {
    await this.recreateFormTables(form, account);
    await this.reloadTableList();

    let index = 0;

    await form.findEachRecord({}, async (record) => {
      record.form = form;

      if (++index % 10 === 0) {
        progress(index);
      }

      await this.updateRecord(record, account, true);
    });

    progress(index);
  }

  formVersion = (form) => {
    if (form == null) {
      return null;
    }

    return {
      id: form._id,
      row_id: form.rowID,
      name: form._name,
      elements: form._elementsJSON
    };
  }
}